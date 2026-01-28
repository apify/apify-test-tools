import { Commit, Config } from './types.js';
import { spawnCommandInGhWorkspace } from './utils.js';

export const GIT_FORMAT_SEPARATOR = '»¦«';
const GIT_LOG_FORMAT = ['%H', '%aN<%aE>', '%aD', '%s'].join(GIT_FORMAT_SEPARATOR);

/**
 * Gets the list of changed files between the given commits (inclusive).
 */
export const getChangedFiles = (commits: Commit[]) => {
    const changedFiles = spawnCommandInGhWorkspace(
        `git diff --name-only ${commits[0].sha}~..${commits[commits.length - 1].sha}`,
    );

    return changedFiles.split('\n');
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
    if (hasBaseCommit) return commits.slice(baseCommitIndex + 1);

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
