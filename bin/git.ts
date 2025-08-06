import { Commit, Config } from './types';
import { spawnCommandInGhWorkspace } from './utils.js';

const GIT_LOG_FORMAT = `{"sha":"%H","author":"%aN<%aE>","date":"%aD","message":"%s"}`;

export const getBranchLastCommit = (branch: string): Commit => {
    const lastCommit = JSON.parse(spawnCommandInGhWorkspace(`git log -1 --pretty=format:'${GIT_LOG_FORMAT}' ${branch}`)) as Commit;
    return lastCommit;
};

export const getChangedFiles = (commits: Commit[]) => {
    const changedFiles = commits.length === 1
        ? spawnCommandInGhWorkspace(`git show --pretty='format:' --name-only ${commits[0].sha}`)
        : spawnCommandInGhWorkspace(`git diff --name-only ${commits[0].sha}..${commits[commits.length - 1].sha}`);
    return changedFiles.split('\n');
};

export const getCommits = ({
    sourceBranch,
    targetBranch,
    baseCommit: baseCommitSha,
}: Config): Commit[] => {
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
    const commitsStrings = spawnCommandInGhWorkspace(`git log --pretty=format:'${GIT_LOG_FORMAT}' ${base.sha}..${sourceBranchCommit.sha}`)
        .split('\n');
    const commits = JSON.parse(`[${commitsStrings.join(',')}]`) as Commit[];
    commits.reverse();
    const baseCommitIndex = baseCommit
        ? commits.findIndex(({ sha }) => sha === baseCommit.sha)
        : -1;
    return commits.slice(baseCommitIndex + 1);
};

export const getBaseCommit = (target: Commit, source: Commit): Commit => {
    const baseCommitSha = spawnCommandInGhWorkspace(`git merge-base ${target.sha} ${source.sha}`);
    const baseCommit = getCommitInfo(baseCommitSha);
    return baseCommit;
};

export const getCommitInfo = (commitSha: string): Commit => {
    return JSON.parse(spawnCommandInGhWorkspace(`git log -1 --pretty=format:'${GIT_LOG_FORMAT}' ${commitSha}`));
};
