import { getChangedActors } from './diff-changes.js';
import {
    getBranchOnlyChangedFiles,
    getChangedFiles,
    getChangelogAdditions,
    getCommits,
    getReleaseChanges,
    hasMergeFromTarget,
    resolveBranchName,
    resolveCommitSha,
    resolveReleaseBaseCommit,
} from './git.js';
import { logger } from './logger.js';
import type { ActorConfig, Commit } from './types.js';
import { readConfigFile } from './utils/config/load-config.js';

export interface AffectedActorsOptions {
    /** End of the range. */
    head: string;
    /** Only the commits on head that are not on base count, i.e. the branch's own changes. */
    base?: string;
    /**
     * Only changes after this commit count. With `base` it's the last validated commit of the branch and is
     * ignored when it isn't on the branch. Without `base` it must be an ancestor of head (e.g. the last release).
     */
    since?: string;
    /** Also report Actors whose changes are only cosmetic (README, CHANGELOG, cosmetic .actor JSON). */
    includeCosmetic: boolean;
    actors: string[];
    ignore: string[];
}

export interface AffectedActors {
    headSha: string;
    /** Branch head points to, which is what git builds are made from. Null for a SHA or a detached HEAD. */
    ref: string | null;
    commits: Commit[];
    changedFiles: string[];
    changelog: string | null;
    actorConfigs: ActorConfig[];
}

type BranchRangeOptions = AffectedActorsOptions & { base: string };
type SinceRangeOptions = AffectedActorsOptions & { since: string };

const getBranchChanges = async ({ head, base, since, includeCosmetic, actors, ignore }: BranchRangeOptions) => {
    const actorConfigs = await readConfigFile({ actors, ignore });

    // This is an optimization for the common case where a branch only has cosmetic changes but had to merge in
    // functional changes from base (being up-to-date is a CI requirement). Base is already validated, and
    // since the branch has no functional changes of its own, there is nothing new to validate.
    // Exception: if the branch has any functional changes alongside the merge, we must re-test — even
    // individually validated changes can have novel interactions when combined.
    let onlyMergedFromBase = false;
    if (await hasMergeFromTarget(head, base)) {
        logger.info(
            '[MERGE-FROM-TARGET-OPTIMIZATION]: There is merge from target branch, checking if there are no functional changes in our own branch. If so, we can skip tests',
        );
        const branchOnlyFiles = await getBranchOnlyChangedFiles(head, base);
        // Omit since to get full branch history. Validated functional commits can still interact with merged ones
        const allBranchCommits = await getCommits({ sourceBranch: head, targetBranch: base });
        const branchOnlyActorsChanged = await getChangedActors({
            filepathsChanged: branchOnlyFiles,
            actorConfigs,
            isLatest: includeCosmetic,
            commits: allBranchCommits,
        });
        onlyMergedFromBase = branchOnlyActorsChanged.length === 0;
        logger.info(
            onlyMergedFromBase
                ? '[MERGE-FROM-TARGET-OPTIMIZATION]: Branch itself has no functional changes, skipping tests'
                : `[MERGE-FROM-TARGET-OPTIMIZATION]: Branch has ${branchOnlyActorsChanged.length} functional changes, cannot optimize, we continue with full check`,
        );
    }

    // If the optimization doesn't apply, we check all branch commits including merges for full coverage. We don't reuse the merge optimization results because here we can apply since and check merge commits (they might be functional or just cosmetic)
    const commits = await getCommits({ sourceBranch: head, targetBranch: base, baseCommit: since });
    const changedFiles = await getChangedFiles(commits);
    const changelog = await getChangelogAdditions(`${commits[0].sha}~`, commits[commits.length - 1].sha, changedFiles);
    const changedActors = onlyMergedFromBase
        ? []
        : await getChangedActors({ filepathsChanged: changedFiles, actorConfigs, isLatest: includeCosmetic, commits });
    return { commits, changedFiles, changelog, actorConfigs: changedActors };
};

const getChangesSince = async ({ head, since, includeCosmetic, actors, ignore }: SinceRangeOptions) => {
    const sinceSha = await resolveReleaseBaseCommit(since, { head, optionName: '--since' });
    const changes = await getReleaseChanges(sinceSha, head);
    if (!changes) {
        logger.info(`${head} is the --since commit ${sinceSha}, nothing changed`);
        return { commits: [], changedFiles: [], changelog: null, actorConfigs: [] };
    }

    const actorConfigs = await readConfigFile({ actors, ignore });
    const changedActors = await getChangedActors({
        filepathsChanged: changes.changedFiles,
        actorConfigs,
        isLatest: includeCosmetic,
        commits: changes.commits,
    });
    return { ...changes, actorConfigs: changedActors };
};

/**
 * Finds the Actors whose context changed in the given range. `base` selects the branch's own commits
 * (a PR), `since` the commits after a known one (a release, or the last validated commit of a PR).
 */
export const getAffectedActors = async (options: AffectedActorsOptions): Promise<AffectedActors> => {
    const { head, base } = options;
    // An empty --since (e.g. an empty cache file) means the same as not passing it
    const since = options.since || undefined;

    let changes: Omit<AffectedActors, 'headSha' | 'ref'>;
    if (base) {
        changes = await getBranchChanges({ ...options, base, since });
    } else if (since) {
        changes = await getChangesSince({ ...options, since });
    } else {
        throw new Error('Pass --base, --since, or both to select the commits to inspect.');
    }

    return { headSha: await resolveCommitSha(head), ref: await resolveBranchName(head), ...changes };
};

/** The JSON document `get-affected-actors` prints. Versioned, since other commands and workflows consume it. */
export const toAffectedActorsDocument = ({
    headSha,
    ref,
    commits,
    changedFiles,
    changelog,
    actorConfigs,
}: AffectedActors) => ({
    version: 1,
    ref,
    head: headSha,
    commits,
    changedFiles,
    changelog,
    actors: actorConfigs.map(({ actorFullName }) => ({ actorFullName })),
});
