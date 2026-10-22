import { type ChangedActors, getChangedActors } from './diff-changes.js';
import {
    findCommitSha,
    getChangedFilesBetween,
    getChangelogAdditions,
    getCommitsBetween,
    getMergeBase,
    resolveCommitSha,
    resolveReleaseBaseCommit,
} from './git.js';
import { logger } from './logger.js';
import type { ActorConfig, Commit, GitRange } from './types.js';
import { readConfigFile } from './utils/config/load-config.js';

// The range always ends at the checked-out commit: check out what you want to inspect
const HEAD = 'HEAD';

interface AffectedActorsOptions {
    /**
     * Only what HEAD changes compared to base counts, like `git diff base...HEAD` or GitHub's "Files changed" tab:
     * the branch's own changes, not what it merged in from base.
     */
    base?: string;
    /**
     * With `base` it's the last validated commit of the branch: Actors that didn't change after it are left out.
     * It's ignored when it is HEAD (a rerun) or isn't in the local history. Without `base` everything after it
     * counts, and it must be an ancestor of HEAD (e.g. the last release).
     */
    since?: string;
    /** Glob relative to the repo root. Matching files count as changes even when .dockerignore lists them. */
    testFilesGlob?: string;
    actors: string[];
    ignore: string[];
}

/** The JSON document `get-affected-actors` prints. Versioned, since other commands and workflows consume it. */
interface AffectedActors {
    version: 1;
    head: string;
    /** The commits, changed files and changelog describe the whole range, `--since` with `--base` only narrows the Actors. */
    commits: Commit[];
    changedFiles: string[];
    changelog: string | null;
    /**
     * Actors with at least one functional change. They need a new build and tests. Only the names: the config file
     * stays the source of truth for the rest.
     */
    functionallyChangedActors: { actorFullName: string }[];
    /** Actors whose changes are all cosmetic (README, CHANGELOG, cosmetic .actor JSON). They only need a release build. */
    cosmeticallyChangedActors: { actorFullName: string }[];
}

const names = (configs: ActorConfig[]) => configs.map(({ actorFullName }) => ({ actorFullName }));

/** The branch's last validated commit, unless it can't narrow anything down. */
const findValidatedSha = async (since: string, headSha: string): Promise<string | undefined> => {
    const sinceSha = await findCommitSha(since);
    if (!sinceSha) {
        logger.info(
            `Last validated commit ${since} is not in the local history (force-push?), checking the whole branch`,
        );
        return undefined;
    }
    if (sinceSha === headSha) {
        logger.info('Last validated commit is HEAD, so this is a rerun: checking the whole branch from scratch');
        return undefined;
    }
    return sinceSha;
};

/**
 * Keeps the Actors the branch changed that also changed since its last validated commit. The two diffs answer
 * different questions: `base...HEAD` is what the branch changes, `since..HEAD` what changed since the last validation,
 * including what came from base through a merge or a rebase. An Actor in only one of them is already validated, either
 * by this branch or on base. Changes in both can interact, so only those are checked again.
 *
 * An Actor is functional only when both diffs say so. A validated functional change of the branch plus cosmetic
 * changes since is cosmetic, and so is a functional change from base meeting only cosmetic changes of the branch.
 *
 * In each example the branch's functional change to Actor A was validated at `since`, then one more push follows:
 *
 * - Our own branch only: a commit changes A's README and B's code.
 *   `since..HEAD`: A cosmetic, B functional. `base...HEAD`: A and B functional.
 *   → A cosmetic, B functional: only B is tested, A's code is still the validated one.
 * - Cosmetic merge: the branch merges base, which only changed READMEs and the CHANGELOG.
 *   `since..HEAD`: every Actor cosmetic (CHANGELOG counts for all). `base...HEAD`: A functional, since the merged
 *   files now match base and drop out of it.
 *   → A cosmetic, the other Actors left out: nothing is tested.
 * - Functional merge: the branch merges base, which changed code of A and of C.
 *   `since..HEAD`: A and C functional. `base...HEAD`: A functional.
 *   → A functional, C left out: A is tested, since base's change can interact with the branch's, while C only has
 *   base's change, which base already validated.
 *
 * This assumes the branch is up to date with base when it merges, which we require. Only then is HEAD what lands on
 * base, and base's commits validated. Otherwise what lands is HEAD combined with base's newer commits, which nobody
 * tested, however the Actors are picked.
 */
const narrowToChangedSince = (branch: ChangedActors, sinceValidated: ChangedActors): ChangedActors => {
    const narrowed: ChangedActors = { functional: [], cosmetic: [] };
    for (const actor of [...branch.functional, ...branch.cosmetic]) {
        const changedFunctionallyOnBranch = branch.functional.includes(actor);
        const changedFunctionallySince = sinceValidated.functional.includes(actor);
        const changedSince = changedFunctionallySince || sinceValidated.cosmetic.includes(actor);

        // Nothing changed since the last validation, so the branch's change to this Actor is already validated
        if (!changedSince) continue;

        // Functional only when both diffs say so, otherwise its code matches a validated version
        if (changedFunctionallyOnBranch && changedFunctionallySince) {
            narrowed.functional.push(actor);
        } else {
            narrowed.cosmetic.push(actor);
        }
    }
    return narrowed;
};

/**
 * Finds the Actors whose context changed in the given range. `base` selects the branch's own changes
 * (a PR), `since` the changes after a known commit (a release, or the last validated commit of a PR).
 */
export const getAffectedActors = async ({
    base,
    since: sinceOption,
    testFilesGlob,
    actors,
    ignore,
}: AffectedActorsOptions): Promise<AffectedActors> => {
    // An empty --since (e.g. an empty cache file) means the same as not passing it
    const since = sinceOption || undefined;
    if (!base && !since) {
        throw new Error('Pass --base, --since, or both to select the commits to inspect.');
    }

    const headSha = await resolveCommitSha(HEAD);
    const actorConfigs = await readConfigFile({ actors, ignore });
    const inspect = async (range: GitRange) => {
        const changedFiles = await getChangedFilesBetween(range.fromRef, range.toRef);
        return {
            changedFiles,
            changed: await getChangedActors({ filepathsChanged: changedFiles, actorConfigs, range, testFilesGlob }),
        };
    };

    const range: GitRange = {
        fromRef: base ? await getMergeBase(base, HEAD) : await resolveReleaseBaseCommit(since!),
        toRef: headSha,
    };
    const { changedFiles, changed: changedInRange } = await inspect(range);

    const validatedSha = base && since ? await findValidatedSha(since, headSha) : undefined;
    const changed = validatedSha
        ? narrowToChangedSince(changedInRange, (await inspect({ fromRef: validatedSha, toRef: headSha })).changed)
        : changedInRange;

    return {
        version: 1,
        head: headSha,
        commits: await getCommitsBetween(range.fromRef, range.toRef),
        changedFiles,
        changelog: await getChangelogAdditions(range.fromRef, range.toRef, changedFiles),
        functionallyChangedActors: names(changed.functional),
        cosmeticallyChangedActors: names(changed.cosmetic),
    };
};
