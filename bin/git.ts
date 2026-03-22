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
    console.error(`Changed files: ${changedFiles.join(', ')}`);
    return changedFiles;
};

/**
 * Gets the commits between sourceBranch and targetBranch (exclusive).
 * - If baseCommit is provided, only returns commits after the baseCommit.
 */
export const getCommits = ({ sourceBranch, targetBranch, baseCommit: baseCommitSha }: Config): Commit[] => {
    const commitsStrings = spawnCommandInGhWorkspace(
        `git log --pretty=format:'${GIT_LOG_FORMAT}' ${targetBranch}..${sourceBranch}`,
    ).split('\n');
    const commits = commitsStrings.map((commitString) => parseCommit(commitString));
    commits.reverse();

    const baseCommitIndex = commits.findIndex((commit) => commit.sha === baseCommitSha);

    const hasBaseCommit = baseCommitIndex !== -1;
    if (hasBaseCommit) {
        const commitsUpToBaseCommit = commits.slice(baseCommitIndex + 1);
        console.error(`Found base commit ${baseCommitSha} at index ${baseCommitIndex}, returning ${commitsUpToBaseCommit.length} commits after it`);
        console.error(`Commits being returned: ${commitsUpToBaseCommit.map((c) => c.sha).join(', ')}`);
        return commitsUpToBaseCommit;
    }

    console.error(`Base commit ${baseCommitSha} not found in the commit range, returning all ${commits.length} commits`);
    console.error(`Commits being returned: ${commits.map((c) => c.sha).join(', ')}`);
    return commits;
};

export const getCommitInfo = (commitSha: string): Commit => {
    const commitString = spawnCommandInGhWorkspace(`git log -1 --pretty=format:'${GIT_LOG_FORMAT}' ${commitSha}`);
    const commit = parseCommit(commitString);
    return commit;
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
