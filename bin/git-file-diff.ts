import { getDiffChangedFiles, getMergeBase } from './git.js';

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
          sinceRef: string;
      };

/**
 * Solves the merge-base of HEAD to targetRef, then lists files changed from that merge-base to HEAD.
 * When sinceRef is supplied, keep only files also changed between sinceRef and HEAD.
 * currentRef is the literal HEAD ref; this function assumes the desired source commit is checked out.
 * For more info, see https://github.com/apify/apify-test-tools/issues/196
 */
export const resolveGitFileDiff = async ({
    targetRef,
    sinceRef,
}: {
    targetRef: string;
    sinceRef?: string;
}): Promise<ResolvedGitFileDiff> => {
    const currentRef = 'HEAD';
    const mergeBaseSha = await getMergeBase(targetRef, currentRef);
    const changedFiles = await getDiffChangedFiles(mergeBaseSha, currentRef);

    if (!sinceRef) {
        return { changedFiles, mergeBaseSha, resolutionType: 'simple', currentRef };
    }

    const filesSince = new Set(await getDiffChangedFiles(sinceRef, currentRef));
    return {
        changedFiles: changedFiles.filter((file) => filesSince.has(file)),
        mergeBaseSha,
        resolutionType: 'intersection',
        currentRef,
        sinceRef,
    };
};
