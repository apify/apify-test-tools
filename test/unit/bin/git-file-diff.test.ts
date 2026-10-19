import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as Git from '../../../bin/git.js';
import { resolveGitFileDiff } from '../../../bin/git-file-diff.js';

describe('resolveGitFileDiff', () => {
    const currentRef = 'HEAD';
    const mergeBaseSha = 'b'.repeat(40);
    const sinceRef = 's'.repeat(40);

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(Git, 'getMergeBase').mockResolvedValue(mergeBaseSha);
    });

    it('returns the merge-base diff when sinceRef is absent', async () => {
        const diffSpy = vi.spyOn(Git, 'getDiffChangedFiles').mockResolvedValue(['src/one.ts', 'src/two.ts']);

        await expect(resolveGitFileDiff({ targetRef: 'main' })).resolves.toStrictEqual({
            changedFiles: ['src/one.ts', 'src/two.ts'],
            mergeBaseSha,
            resolutionType: 'simple',
            currentRef,
        });
        expect(Git.getMergeBase).toHaveBeenCalledWith('main', currentRef);
        expect(diffSpy).toHaveBeenCalledExactlyOnceWith(mergeBaseSha, currentRef);
    });

    it('intersects the merge-base diff with the net diff since sinceRef', async () => {
        const diffSpy = vi
            .spyOn(Git, 'getDiffChangedFiles')
            .mockResolvedValueOnce(['src/one.ts', 'src/two.ts'])
            .mockResolvedValueOnce(['src/two.ts', 'src/three.ts']);

        await expect(resolveGitFileDiff({ targetRef: 'main', sinceRef })).resolves.toStrictEqual({
            changedFiles: ['src/two.ts'],
            mergeBaseSha,
            resolutionType: 'intersection',
            currentRef,
            sinceRef,
        });
        expect(diffSpy).toHaveBeenNthCalledWith(1, mergeBaseSha, currentRef);
        expect(diffSpy).toHaveBeenNthCalledWith(2, sinceRef, currentRef);
    });

    it('returns no files when the sinceRef diff is empty', async () => {
        vi.spyOn(Git, 'getDiffChangedFiles').mockResolvedValueOnce(['src/one.ts']).mockResolvedValueOnce([]);

        await expect(resolveGitFileDiff({ targetRef: 'main', sinceRef })).resolves.toMatchObject({
            changedFiles: [],
            resolutionType: 'intersection',
        });
    });
});
