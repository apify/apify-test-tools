import { Commit, Config } from './types.js';
import { spawnCommandInGhWorkspace } from './utils.js';

export const GIT_FORMAT_SEPARATOR = '»¦«';
const GIT_LOG_FORMAT = ['%H', '%aN<%aE>', '%aD', '%s'].join(GIT_FORMAT_SEPARATOR);

export const getBranchLastCommit = (branch: string): Commit => {
    const commitString = spawnCommandInGhWorkspace(`git log -1 --pretty=format:'${GIT_LOG_FORMAT}' ${branch}`);
    const commit = parseCommit(commitString);
    return commit;
};

export const getChangedFiles = (commits: Commit[]) => {
    const changedFiles =
        commits.length === 1
            ? spawnCommandInGhWorkspace(`git show --pretty='format:' --name-only ${commits[0].sha}`)
            : spawnCommandInGhWorkspace(`git diff --name-only ${commits[0].sha}..${commits[commits.length - 1].sha}`);
    return changedFiles.split('\n');
};

export const getCommits = ({ sourceBranch, targetBranch, baseCommit: baseCommitSha }: Config): Commit[] => {
    const targetBranchCommit = getBranchLastCommit(targetBranch);
    const sourceBranchCommit = getBranchLastCommit(sourceBranch);
    let baseCommit: Commit | undefined;
    if (baseCommitSha) {
        try {
            baseCommit = getCommitInfo(baseCommitSha);
        } catch (err) {
            console.warn(`Failed to get base commit "${baseCommitSha}", it will not be used: ${err}`);
        }
    }
    // const baseCommit = baseCommitSha !== undefined ?  : undefined;
    // const gitOutputFormat = '{"sha":"%H","author":"%aN<%aE>","date":"%aD","message":"%f"}';
    // console.log(`git log --pretty=format:"${gitOutputFormat}" ${targetBranch}..${sourceBranch}`);
    // return [];
    const base = getBaseCommit(sourceBranchCommit, targetBranchCommit);
    const commitsStrings = spawnCommandInGhWorkspace(
        `git log --pretty=format:'${GIT_LOG_FORMAT}' ${base.sha}..${sourceBranchCommit.sha}`
    ).split('\n');
    const commits = commitsStrings.map((commitString) => parseCommit(commitString)) as Commit[];
    commits.reverse();
    const baseCommitIndex = baseCommit ? commits.findIndex(({ sha }) => sha === baseCommit.sha) : -1;
    return commits.slice(baseCommitIndex + 1);
};

export const getBaseCommit = (target: Commit, source: Commit): Commit => {
    const baseCommitSha = spawnCommandInGhWorkspace(`git merge-base ${target.sha} ${source.sha}`);
    const baseCommit = getCommitInfo(baseCommitSha);
    return baseCommit;
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
