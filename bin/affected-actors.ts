import { type ChangedActors, getChangedActors } from './diff-changes.js';
import {
    getBranchOnlyChangedFiles,
    getChangedFilesBetween,
    getChangelogAdditions,
    getCommits,
    getCommitsBetween,
    hasMergeFromTarget,
    resolveBranchName,
    resolveCommitSha,
    resolveReleaseBaseCommit,
} from './git.js';
import { logger } from './logger.js';
import type { ActorConfig, Commit } from './types.js';
import { readConfigFile } from './utils/config/load-config.js';

interface AffectedActorsOptions {
    /** End of the range. */
    head: string;
    /** Only the commits on head that are not on base count, i.e. the branch's own changes. */
    base?: string;
    /**
     * Only changes after this commit count. With `base` it's the last validated commit of the branch and is
     * ignored when it isn't on the branch. Without `base` it must be an ancestor of head (e.g. the last release).
     */
    since?: string;
    actors: string[];
    ignore: string[];
}

interface AffectedActors {
    headSha: string;
    /** Branch head points to, which is what git builds are made from. Null for a SHA or a detached HEAD. */
    ref: string | null;
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
const getBranchRange = async (head: string, base: string, since: string | undefined): Promise<CommitRange> => {
    const commits = await getCommits({ sourceBranch: head, targetBranch: base, baseCommit: since });
    return { commits, fromRef: `${commits[0].sha}~`, toRef: commits[commits.length - 1].sha };
};

/** Everything after `since` up to head. Unlike on a branch, `since` must be an ancestor of head. */
const getRangeSince = async (head: string, headSha: string, since: string): Promise<CommitRange> => {
    const sinceSha = await resolveReleaseBaseCommit(since, head);
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
 */
const getOwnChangesIfMergedFromBase = async (
    head: string,
    base: string,
    actorConfigs: ActorConfig[],
): Promise<ChangedActors | undefined> => {
    if (!(await hasMergeFromTarget(head, base))) return undefined;

    logger.info(
        '[MERGE-FROM-TARGET-OPTIMIZATION]: There is merge from target branch, checking if there are no functional changes in our own branch. If so, we can skip tests',
    );
    const own = await getChangedActors({
        filepathsChanged: await getBranchOnlyChangedFiles(head, base),
        actorConfigs,
        // Omit since to get full branch history. Validated functional commits can still interact with merged ones
        commits: await getCommits({ sourceBranch: head, targetBranch: base }),
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
    head,
    base,
    since: sinceOption,
    actors,
    ignore,
}: AffectedActorsOptions): Promise<AffectedActors> => {
    // An empty --since (e.g. an empty cache file) means the same as not passing it
    const since = sinceOption || undefined;
    if (!base && !since) {
        throw new Error('Pass --base, --since, or both to select the commits to inspect.');
    }

    const headSha = await resolveCommitSha(head);
    const { commits, fromRef, toRef } = base
        ? await getBranchRange(head, base, since)
        : await getRangeSince(head, headSha, since!);
    const actorConfigs = await readConfigFile({ actors, ignore });

    // What the branch only merged in from base is already validated. Without functional changes of its own
    // the branch has nothing to test, and without any changes of its own nothing to release either.
    const own = base ? await getOwnChangesIfMergedFromBase(head, base, actorConfigs) : undefined;
    const changedFiles = await getChangedFilesBetween(fromRef, toRef);
    const changed = await getChangedActors({ filepathsChanged: changedFiles, actorConfigs, commits });

    return {
        headSha,
        ref: await resolveBranchName(head),
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
    ref,
    commits,
    changedFiles,
    changelog,
    functionallyChangedActors,
    cosmeticallyChangedActors,
}: AffectedActors) => {
    const names = (configs: ActorConfig[]) => configs.map(({ actorFullName }) => ({ actorFullName }));
    return {
        version: 1,
        ref,
        head: headSha,
        commits,
        changedFiles,
        changelog,
        functionallyChangedActors: names(functionallyChangedActors),
        cosmeticallyChangedActors: names(cosmeticallyChangedActors),
    };
};
