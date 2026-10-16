import { type ChangedActors, getChangedActors } from './diff-changes.js';
import {
    getBranchOnlyChangedFiles,
    getChangedFilesBetween,
    getChangelogAdditions,
    getCommits,
    getCommitsBetween,
    hasMergeFromTarget,
    resolveCommitSha,
    resolveReleaseBaseCommit,
} from './git.js';
import { logger } from './logger.js';
import type { ActorConfig, Commit } from './types.js';
import { readConfigFile } from './utils/config/load-config.js';

// The range always ends at the checked-out commit: check out what you want to inspect
const HEAD = 'HEAD';

interface AffectedActorsOptions {
    /** Only the commits on HEAD that are not on base count, i.e. the branch's own changes. */
    base?: string;
    /**
     * Only changes after this commit count. With `base` it's the last validated commit of the branch and is
     * ignored when it isn't on the branch. Without `base` it must be an ancestor of HEAD (e.g. the last release).
     */
    since?: string;
    /** Glob relative to the repo root. Matching files count as changes even when .dockerignore lists them. */
    testFilesGlob?: string;
    actors: string[];
    ignore: string[];
}

interface AffectedActors {
    headSha: string;
    commits: Commit[];
    changedFiles: string[];
    changelog: string | null;
    /** Actors with at least one functional change. They need a new build and tests. */
    functionallyChangedActors: ActorConfig[];
    /** Actors whose changes are all cosmetic (README, CHANGELOG, cosmetic .actor JSON). They only need a release build. */
    cosmeticallyChangedActors: ActorConfig[];
}

interface CommitRange {
    commits: Commit[];
    fromRef: string;
    toRef: string;
}

/** The branch's own commits, after `since` when it is on the branch (see getCommits). */
const getBranchRange = async (base: string, since: string | undefined): Promise<CommitRange> => {
    const commits = await getCommits({ sourceBranch: HEAD, targetBranch: base, baseCommit: since });
    return { commits, fromRef: `${commits[0].sha}~`, toRef: commits[commits.length - 1].sha };
};

/** Everything after `since` up to HEAD. Unlike on a branch, `since` must be an ancestor of HEAD. */
const getRangeSince = async (headSha: string, since: string): Promise<CommitRange> => {
    const sinceSha = await resolveReleaseBaseCommit(since);
    const commits = sinceSha === headSha ? [] : await getCommitsBetween(sinceSha, headSha);
    return { commits, fromRef: sinceSha, toRef: headSha };
};

/**
 * This is an optimization for the common case where a branch only has cosmetic changes but had to merge in
 * functional changes from base (being up-to-date is a CI requirement). Base is already validated, and
 * since the branch has no functional changes of its own, there is nothing new to validate.
 * Exception: if the branch has any functional changes alongside the merge, we must re-test — even
 * individually validated changes can have novel interactions when combined.
 * Returns the Actors the branch's own commits changed, or undefined when it didn't merge base in.
 *
 * TODO: Apply this per Actor instead of to the whole branch. Changes merged in from base only interact with the
 * branch's own changes in Actors whose context both touch, so an Actor that only base changed is already validated
 * and can be skipped even when the branch changes other Actors functionally. Today any functional change of the
 * branch's own keeps every Actor, and the log messages below describe the whole branch.
 */
const getOwnChangesIfMergedFromBase = async (
    base: string,
    actorConfigs: ActorConfig[],
    testFilesGlob: string | undefined,
): Promise<ChangedActors | undefined> => {
    if (!(await hasMergeFromTarget(HEAD, base))) return undefined;

    logger.info(
        '[MERGE-FROM-TARGET-OPTIMIZATION]: There is merge from target branch, checking if there are no functional changes in our own branch. If so, we can skip tests',
    );
    const own = await getChangedActors({
        filepathsChanged: await getBranchOnlyChangedFiles(HEAD, base),
        actorConfigs,
        // Omit since to get full branch history. Validated functional commits can still interact with merged ones
        commits: await getCommits({ sourceBranch: HEAD, targetBranch: base }),
        testFilesGlob,
    });
    logger.info(
        own.functional.length > 0
            ? `[MERGE-FROM-TARGET-OPTIMIZATION]: Branch has ${own.functional.length} functional changes, cannot optimize, we continue with full check`
            : '[MERGE-FROM-TARGET-OPTIMIZATION]: Branch itself has no functional changes, skipping tests',
    );
    return own;
};

/**
 * Finds the Actors whose context changed in the given range. `base` selects the branch's own commits
 * (a PR), `since` the commits after a known one (a release, or the last validated commit of a PR).
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
    const { commits, fromRef, toRef } = base ? await getBranchRange(base, since) : await getRangeSince(headSha, since!);
    const actorConfigs = await readConfigFile({ actors, ignore });

    // What the branch only merged in from base is already validated. Without functional changes of its own
    // the branch has nothing to test, and without any changes of its own nothing to release either.
    const own = base ? await getOwnChangesIfMergedFromBase(base, actorConfigs, testFilesGlob) : undefined;
    const changedFiles = await getChangedFilesBetween(fromRef, toRef);
    const changed = await getChangedActors({ filepathsChanged: changedFiles, actorConfigs, commits, testFilesGlob });

    return {
        headSha,
        commits,
        changedFiles,
        changelog: await getChangelogAdditions(fromRef, toRef, changedFiles),
        functionallyChangedActors: own && own.functional.length === 0 ? [] : changed.functional,
        cosmeticallyChangedActors: own && own.functional.length + own.cosmetic.length === 0 ? [] : changed.cosmetic,
    };
};

/** The JSON document `get-affected-actors` prints. Versioned, since other commands and workflows consume it. */
export const toAffectedActorsDocument = ({
    headSha,
    commits,
    changedFiles,
    changelog,
    functionallyChangedActors,
    cosmeticallyChangedActors,
}: AffectedActors) => {
    const names = (configs: ActorConfig[]) => configs.map(({ actorFullName }) => ({ actorFullName }));
    return {
        version: 1,
        head: headSha,
        commits,
        changedFiles,
        changelog,
        functionallyChangedActors: names(functionallyChangedActors),
        cosmeticallyChangedActors: names(cosmeticallyChangedActors),
    };
};
