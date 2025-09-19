import { Commit, Config } from './types';
import { spawnCommandInGhWorkspace } from './utils.js';

const GIT_LOG_FORMAT = `{"sha":"%H","author":"%aN<%aE>","date":"%aD","message":"%s"}`;

export const getBranchLastCommit = (branch: string, workspace: string | undefined): Commit => {
    const lastCommit = JSON.parse(spawnCommandInGhWorkspace({ command: `git log -1 --pretty=format:'${GIT_LOG_FORMAT}' ${branch}`, workspace })) as Commit;
    return lastCommit;
};

export const getChangedFiles = (commits: Commit[], workspace: string | undefined) => {
    const changedFiles = commits.length === 1
        ? spawnCommandInGhWorkspace({ command: `git show --pretty='format:' --name-only ${commits[0].sha}`, workspace })
        : spawnCommandInGhWorkspace({ command: `git diff --name-only ${commits[0].sha}..${commits[commits.length - 1].sha}`, workspace });
    return changedFiles.split('\n');
};

export const getCommits = ({
    sourceBranch,
    targetBranch,
    baseCommit: baseCommitSha,
    workspace
}: Config): Commit[] => {
    const targetBranchCommit = getBranchLastCommit(targetBranch, workspace);
    const sourceBranchCommit = getBranchLastCommit(sourceBranch, workspace);
    let baseCommit: Commit | undefined;
    if (baseCommitSha) {
        try {
            baseCommit = getCommitInfo(baseCommitSha, workspace);
        } catch (err) {
            console.warn(`Failed to get base commit "${baseCommitSha}", it will not be used: ${err}`);
        }
    }
    // const baseCommit = baseCommitSha !== undefined ?  : undefined;
    // const gitOutputFormat = '{"sha":"%H","author":"%aN<%aE>","date":"%aD","message":"%f"}';
    // console.log(`git log --pretty=format:"${gitOutputFormat}" ${targetBranch}..${sourceBranch}`);
    // return [];
    const base = getBaseCommit(sourceBranchCommit, targetBranchCommit, workspace);
    const commitsStrings = spawnCommandInGhWorkspace({ command: `git log --pretty=format:'${GIT_LOG_FORMAT}' ${base.sha}..${sourceBranchCommit.sha}`, workspace })
        .split('\n');
    const commits = JSON.parse(`[${commitsStrings.join(',')}]`) as Commit[];
    commits.reverse();
    const baseCommitIndex = baseCommit
        ? commits.findIndex(({ sha }) => sha === baseCommit.sha)
        : -1;
    return commits.slice(baseCommitIndex + 1);
};

export const getBaseCommit = (target: Commit, source: Commit, workspace: string | undefined): Commit => {
    const baseCommitSha = spawnCommandInGhWorkspace({ command: `git merge-base ${target.sha} ${source.sha}`, workspace });
    const baseCommit = getCommitInfo(baseCommitSha, workspace);
    return baseCommit;
};

export const getCommitInfo = (commitSha: string, workspace: string | undefined): Commit => {
    return JSON.parse(spawnCommandInGhWorkspace({ command: `git log -1 --pretty=format:'${GIT_LOG_FORMAT}' ${commitSha}`, workspace }));
};
