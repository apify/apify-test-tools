import { getDiffChangedFiles, getMergeBase } from './git.js';
import { logger } from './logger.js';
import type { Config } from './types.js';

export type ResolvedGitFileDiff =
    | {
          resolutionType: 'simple';
          changedFiles: string[];
          mergeBaseSha: string;
          currentRef: string;
      }
    | {
          resolutionType: 'intersection';
          changedFiles: string[];
          mergeBaseSha: string;
          currentRef: string;
          baseCommit: string;
      };

/**
 * Solves the merge-base of HEAD to targetRef, then lists files changed from that merge-base to HEAD.
 * When baseCommit is supplied, keep only files also changed between baseCommit and HEAD.
 * currentRef is the literal HEAD ref; this function assumes the desired source commit is checked out.
 * For more info, see https://github.com/apify/apify-test-tools/issues/196
 */
export const resolveGitFileDiff = async ({
    targetBranch,
    baseCommit,
}: Pick<Config, 'targetBranch' | 'baseCommit'>): Promise<ResolvedGitFileDiff> => {
    const currentRef = 'HEAD';
    const mergeBaseSha = await getMergeBase(targetBranch, currentRef);
    const changedFiles = await getDiffChangedFiles(mergeBaseSha, currentRef);

    if (!baseCommit) {
        return { changedFiles, mergeBaseSha, resolutionType: 'simple', currentRef };
    }
    const changesSince = await getDiffChangedFiles(baseCommit, currentRef);
    if (changesSince.length === 0) {
        // Most likely a re-run with the same commit that we already validated
        logger.info(
            `previous ref ${baseCommit} has no changes compared to ${currentRef}, returning all changes since merge-base ${mergeBaseSha}`,
        );
        return { changedFiles, mergeBaseSha, resolutionType: 'simple', currentRef };
    }

    const filesSince = new Set(changesSince);
    return {
        changedFiles: changedFiles.filter((file) => filesSince.has(file)),
        mergeBaseSha,
        resolutionType: 'intersection',
        currentRef,
        baseCommit,
    };
};
