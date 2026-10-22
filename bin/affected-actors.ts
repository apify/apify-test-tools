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
     * Base usually points to the master branch
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
 * This is Juan's magical algorithm where we need just 2 git diffs to determine functional changes on Actors.
 * 
 * Naively, we could just check branch HEAD changes vs base or parent of first commit and be done but 
 * we do this jiu-jitsu code to apply 2 optimizations:
 * 1. On our PR branch, we track last validated commit (since) that was tested and so we only need to test new commits.
 * 2. We also merge changes from the base branch (usually master) and we can consider those already validated as well.
 * 
 * But there is annoying problem: even if both our branch and base are validated, they could have novel interactions and
 * we need to retest those.
 * 
 * So we look at:
 * 1. The changes introduced by our branch since the last validated commit (`since..HEAD`).
 * 2. The changes introduced by the branch compared to the base branch (`base...HEAD`). The important part is that this
 * diff does check the whole branch, discarding the last validated commit (since) so it checks those novel interactions problem.
 * 
 * The magic is that both need to contain changes for an Actor to be retested:
 * 1. If we have changes only in since..HEAD (and not in base...HEAD), it means those changes came from merging the base alone
 * which is already validated and there were actually no real changes introduced by our branch alone.
 * 2. If we have changes only in base...HEAD (and not in since..HEAD), it means there are no new changes on our branch
 * since it was last validated. base...HEAD has changes that we already validated.
 * 
 * This enables to simply do those 2 diffs for each Actor's context separately and only Actors that have changes
 * in both diffs need to be retested.
 * 
 * THIS ASSUMES BRANCH IS UP TO DATE WITH BASE WHEN IT MERGES, which we currently require. Only then is HEAD what lands on
 * base, and base's commits validated. Otherwise what lands is HEAD combined with base's newer commits, which nobody
 * tested, however the Actors are picked.
 *
 * In each example the branch's functional change to Actor A was validated at `since`, then one more push follows:
 *
 * Example scenarios:
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
 */
const intersectChangedInBranchVsSince = (branch: ChangedActors, sinceValidated: ChangedActors): ChangedActors => {
    const narrowed: ChangedActors = { functional: [], cosmetic: [] };
    // All checks are done for each Actor separately, that's cleanest and most accurate
    for (const actor of [...branch.functional, ...branch.cosmetic]) {
        // base...HEAD
        const changedFunctionallyOnBranch = branch.functional.includes(actor);
        // since..HEAD
        const changedFunctionallySince = sinceValidated.functional.includes(actor);

        // changedSince is used for release. Release cares also about cosmetic.
        const changedSince = changedFunctionallySince || sinceValidated.cosmetic.includes(actor);

        // Nothing changed since the last validation, so the branch's change to this Actor is already validated
        if (!changedSince) continue;

        // As we said, only intersection counts as functional, otherwise it's cosmetic
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

    const actorConfigs = await readConfigFile({ actors, ignore });
    const getChangedInRange = async (range: GitRange) => {
        const changedFiles = await getChangedFilesBetween(range.fromRef, range.toRef);
        return {
            changedFiles,
            changedActors: await getChangedActors({ filepathsChanged: changedFiles, actorConfigs, range, testFilesGlob }),
        };
    };

    const headSha = await resolveCommitSha(HEAD);
    const rangeVsBase: GitRange = {
        // merge base = PR, release base = push to master (release)
        fromRef: base ? await getMergeBase(base, HEAD) : await resolveReleaseBaseCommit(since!),
        toRef: headSha,
    };

    // Falls back to rangeVsBase.fromRef when there's no (usable) last validated commit — same as
    // intersecting the branch's changes with themselves, which is a no-op (see this function's docs).
    const validatedSha = base && since ? await findValidatedSha(since, headSha) : undefined;
    const sinceFromRef = validatedSha ?? rangeVsBase.fromRef;

    const { changedFiles, changedActors: changedVsBase } = await getChangedInRange(rangeVsBase);
    const { changedActors: changedSinceActors } = await getChangedInRange({ fromRef: sinceFromRef, toRef: headSha });
    // See this function's docs to understand the algorithm: only intersection counts as functional, otherwise it's cosmetic.
    const changedActors = intersectChangedInBranchVsSince(changedVsBase, changedSinceActors);

    return {
        version: 1,
        head: headSha,
        commits: await getCommitsBetween(rangeVsBase.fromRef, rangeVsBase.toRef),
        changedFiles,
        changelog: await getChangelogAdditions(rangeVsBase.fromRef, rangeVsBase.toRef, changedFiles),
        functionallyChangedActors: names(changedActors.functional),
        cosmeticallyChangedActors: names(changedActors.cosmetic),
    };
};
