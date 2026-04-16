import type { Commit, Config } from './types.js';
import { spawnCommandInGhWorkspace } from './utils.js';

export const GIT_FORMAT_SEPARATOR = '»¦«';
const GIT_LOG_FORMAT = ['%H', '%aN<%aE>', '%aD', '%s'].join(GIT_FORMAT_SEPARATOR);

/**
 * Gets the list of changed files between the given commits (inclusive).
 */
export const getChangedFiles = (commits: Commit[]) => {
    const changedFilesString = spawnCommandInGhWorkspace(
        `git diff --name-only ${commits[0].sha}~..${commits[commits.length - 1].sha}`,
    );

    const changedFiles = changedFilesString.split('\n');
    console.error(`Changed files (up to 50): ${changedFiles.slice(0, 50).join(', ')}`);
    return changedFiles;
};

/**
 * Returns true if the branch contains a merge commit whose parent is reachable from targetBranch
 * (i.e. a genuine "merge from target" commit, not a merge of some unrelated branch).
 * Uses the full targetBranch..sourceBranch range, ignoring baseCommit.
 */
export const hasMergeFromTarget = (sourceBranch: string, targetBranch: string): boolean => {
    const mergeShas = spawnCommandInGhWorkspace(`git log --merges --pretty=format:%H ${targetBranch}..${sourceBranch}`)
        .split('\n')
        .filter(Boolean);

    for (const sha of mergeShas) {
        const parents = spawnCommandInGhWorkspace(`git log -1 --pretty=format:%P ${sha}`).trim().split(' ');
        for (const parent of parents) {
            // git merge-base A B outputs the common ancestor.
            // If that equals A, then A is an ancestor of B (i.e. parent is reachable from targetBranch).
            const mergeBase = spawnCommandInGhWorkspace(`git merge-base ${parent} ${targetBranch}`);
            if (mergeBase === parent) {
                return true;
            }
        }
    }
    return false;
};

/**
 * Returns all files touched by non-merge commits on the branch (full history, ignoring baseCommit).
 * Used to check whether the branch itself has any functional changes, independent of what master merged in.
 */
export const getBranchOnlyChangedFiles = (sourceBranch: string, targetBranch: string): string[] => {
    const output = spawnCommandInGhWorkspace(
        `git log --no-merges --name-only --pretty=format: ${targetBranch}..${sourceBranch}`,
    );
    return output.split('\n').filter(Boolean);
};

const SHA_REGEX = /^[0-9a-f]{40}$/i;

/**
 *
 * @param shaOrCommit Supports both a SHA string or a Commit object in JSON format. Can be empty.
 * @returns The SHA string if valid, otherwise throws an error.
 */
export const parseBaseCommit = (shaOrCommit: string | undefined): string | undefined => {
    if (!shaOrCommit) return undefined;
    let sha: string;
    if (shaOrCommit.startsWith('{')) {
        sha = (JSON.parse(shaOrCommit) as Commit).sha;
    } else {
        sha = shaOrCommit;
    }
    if (!SHA_REGEX.test(sha)) {
        throw new Error(
            `Invalid base commit SHA: "${sha}". It should be a 40-character hexadecimal string, instead got input: "${shaOrCommit}".`,
        );
    }
    return sha;
};

const fetchAllBranchCommits = (sourceBranch: string, targetBranch: string): Commit[] => {
    const commitsStrings = spawnCommandInGhWorkspace(
        `git log --pretty=format:'${GIT_LOG_FORMAT}' ${targetBranch}..${sourceBranch}`,
    ).split('\n');
    const commits = commitsStrings.map((commitString) => parseCommit(commitString));
    commits.reverse();
    return commits;
};

/**
 * Gets the commits between sourceBranch and targetBranch (exclusive).
 * - If baseCommit is provided, only returns commits after the baseCommit.
 */
export const getCommits = ({ sourceBranch, targetBranch, baseCommit }: Config): Commit[] => {
    const baseCommitSha = parseBaseCommit(baseCommit);
    const commits = fetchAllBranchCommits(sourceBranch, targetBranch);

    const baseCommitIndex = commits.findIndex((commit) => commit.sha === baseCommitSha);

    const hasBaseCommit = baseCommitIndex !== -1;
    if (hasBaseCommit) {
        const commitsUpToBaseCommit = commits.slice(baseCommitIndex + 1);
        console.error(
            `Found base commit ${baseCommitSha} at index ${baseCommitIndex}, returning ${commitsUpToBaseCommit.length} commits after it`,
        );
        console.error(`Commits being returned: ${commitsUpToBaseCommit.map((c) => c.sha).join(', ')}`);
        return commitsUpToBaseCommit;
    }

    console.error(
        `Base commit ${baseCommitSha} not found in the commit range, returning all ${commits.length} commits`,
    );
    console.error(`Commits being returned: ${commits.map((c) => c.sha).join(', ')}`);
    return commits;
};

export const parseCommit = (commitString: string): Commit => {
    const splits = commitString.split(GIT_FORMAT_SEPARATOR);
    if (splits.length !== 4) {
        throw new Error(`Failed to parse commit string: ${commitString}`);
    }
    const [sha, author, date, message] = splits;
    return {
        sha,
        author,
        date,
        message,
    };
};
