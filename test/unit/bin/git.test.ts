import type { MockInstance } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    getBranchOnlyChangedFiles,
    getChangedFiles,
    getCommits,
    getCurrentBranch,
    getReleaseChanges,
    getRepoName,
    hasMergeFromTarget,
    normalizeRepoUrl,
    parseBaseCommit,
    resolveReleaseBaseCommit,
    resolveRepoUrl,
} from '../../../bin/git.js';
import * as Utils from '../../../bin/utils.js';

describe('getCommits', () => {
    const sourceBranch = 'feature-branch';
    const targetBranch = 'main';

    const sha1 = '1'.repeat(40);
    const sha2 = '2'.repeat(40);
    const sha3 = '3'.repeat(40);

    const commit1 = `${sha1}»¦«Author1»¦«Date1»¦«First Change On Feature`;
    const commit2 = `${sha2}»¦«Author1»¦«Date2»¦«Second Change On Feature`;
    const commit3 = `${sha3}»¦«Author1»¦«Date3»¦«Third Change On Feature`;

    let gitCommandSpy: MockInstance;

    beforeEach(() => {
        gitCommandSpy = vi.spyOn(Utils, 'runGitCommand').mockResolvedValue(`${commit3}\n${commit2}\n${commit1}`);
    });

    it('should return commits between source and target branches', async () => {
        // Act
        const commits = await getCommits({ sourceBranch, targetBranch });

        // Assert
        expect(commits).toStrictEqual([
            { sha: sha1, author: 'Author1', date: 'Date1', message: 'First Change On Feature' },
            { sha: sha2, author: 'Author1', date: 'Date2', message: 'Second Change On Feature' },
            { sha: sha3, author: 'Author1', date: 'Date3', message: 'Third Change On Feature' },
        ]);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith([
            'log',
            '--pretty=format:%H»¦«%aN<%aE>»¦«%aD»¦«%s',
            'main..feature-branch',
        ]);
    });

    it('should return commits after the base commit if provided', async () => {
        // Act
        const commits = await getCommits({ sourceBranch, targetBranch, baseCommit: sha1 });

        // Assert
        expect(commits).toStrictEqual([
            { sha: sha2, author: 'Author1', date: 'Date2', message: 'Second Change On Feature' },
            { sha: sha3, author: 'Author1', date: 'Date3', message: 'Third Change On Feature' },
        ]);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith([
            'log',
            '--pretty=format:%H»¦«%aN<%aE>»¦«%aD»¦«%s',
            'main..feature-branch',
        ]);
    });

    it('should ignore the base commit and return all commits when it is the branch HEAD (rerun or force push)', async () => {
        // Act
        const commits = await getCommits({ sourceBranch, targetBranch, baseCommit: sha3 });

        // Assert
        expect(commits).toStrictEqual([
            { sha: sha1, author: 'Author1', date: 'Date1', message: 'First Change On Feature' },
            { sha: sha2, author: 'Author1', date: 'Date2', message: 'Second Change On Feature' },
            { sha: sha3, author: 'Author1', date: 'Date3', message: 'Third Change On Feature' },
        ]);
    });

    it('should return all commits if base commit is not found', async () => {
        // Act
        const commits = await getCommits({ sourceBranch, targetBranch, baseCommit: 'a'.repeat(40) });

        // Assert
        expect(commits).toStrictEqual([
            { sha: sha1, author: 'Author1', date: 'Date1', message: 'First Change On Feature' },
            { sha: sha2, author: 'Author1', date: 'Date2', message: 'Second Change On Feature' },
            { sha: sha3, author: 'Author1', date: 'Date3', message: 'Third Change On Feature' },
        ]);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith([
            'log',
            '--pretty=format:%H»¦«%aN<%aE>»¦«%aD»¦«%s',
            'main..feature-branch',
        ]);
    });
});

describe('getChangedFiles', () => {
    let gitCommandSpy: MockInstance;

    beforeEach(() => {
        gitCommandSpy = vi.spyOn(Utils, 'runGitCommand').mockResolvedValue('file1.txt\nfolder/file2.txt');
    });

    it('should return changed files between commits', async () => {
        // Arrange
        const firstSha = '1'.repeat(40);
        const lastSha = '3'.repeat(40);
        const commits = [
            { sha: firstSha, author: '', date: '', message: '' },
            { sha: lastSha, author: '', date: '', message: '' },
        ];

        // Act
        const changedFiles = await getChangedFiles(commits);

        // Assert
        expect(changedFiles).toStrictEqual(['file1.txt', 'folder/file2.txt']);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith(['diff', '--name-only', `${firstSha}~..${lastSha}`]);
    });

    it('should throw without running git when the commit list is empty', async () => {
        // Act & Assert
        await expect(getChangedFiles([])).rejects.toThrow('Cannot get changed files: the commit list is empty');
        expect(gitCommandSpy).not.toHaveBeenCalled();
    });

    it('should handle only one commit', async () => {
        // Arrange
        const onlySha = '1'.repeat(40);
        const commits = [{ sha: onlySha, author: '', date: '', message: '' }];

        // Act
        const changedFiles = await getChangedFiles(commits);

        // Assert
        expect(changedFiles).toStrictEqual(['file1.txt', 'folder/file2.txt']);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith(['diff', '--name-only', `${onlySha}~..${onlySha}`]);
    });

    it('should return an empty list when the net diff is empty (e.g. a commit and its revert)', async () => {
        // Arrange
        gitCommandSpy.mockResolvedValue('');
        const commits = [
            { sha: '1'.repeat(40), author: '', date: '', message: '' },
            { sha: '2'.repeat(40), author: '', date: '', message: '' },
        ];

        // Act
        const changedFiles = await getChangedFiles(commits);

        // Assert
        expect(changedFiles).toStrictEqual([]);
    });
});

describe('hasMergeFromTarget', () => {
    const sourceBranch = 'feature-branch';
    const targetBranch = 'main';
    const mergeSha = 'f'.repeat(40);
    const branchParentSha = 'b'.repeat(40);
    const targetParentSha = 't'.repeat(40);
    const differentMergeBase = '0'.repeat(40);

    let gitCommandSpy: MockInstance;

    beforeEach(() => {
        gitCommandSpy = vi.spyOn(Utils, 'runGitCommand');
    });

    it('should return false when there are no merge commits on the branch', async () => {
        gitCommandSpy.mockImplementation(async (args: string[]) => {
            if (args.includes('--merges')) return '';
            return '';
        });

        await expect(hasMergeFromTarget(sourceBranch, targetBranch)).resolves.toBe(false);
        expect(gitCommandSpy).toHaveBeenCalledWith([
            'log',
            '--merges',
            '--pretty=format:%H',
            `${targetBranch}..${sourceBranch}`,
        ]);
    });

    it('should return true when a merge commit has a parent reachable from targetBranch', async () => {
        gitCommandSpy.mockImplementation(async (args: string[]) => {
            if (args.includes('--merges')) return mergeSha;
            if (args.includes('--pretty=format:%P')) return `${branchParentSha} ${targetParentSha}`;
            if (args[0] === 'merge-base' && args[1] === branchParentSha) return differentMergeBase;
            if (args[0] === 'merge-base' && args[1] === targetParentSha) return targetParentSha;
            return '';
        });

        await expect(hasMergeFromTarget(sourceBranch, targetBranch)).resolves.toBe(true);
        expect(gitCommandSpy).toHaveBeenCalledWith(['merge-base', targetParentSha, targetBranch]);
    });

    it('should return false when the merge commit parent is not reachable from targetBranch (unrelated branch merge)', async () => {
        const unrelatedSha = 'e'.repeat(40);
        gitCommandSpy.mockImplementation(async (args: string[]) => {
            if (args.includes('--merges')) return mergeSha;
            if (args.includes('--pretty=format:%P')) return `${branchParentSha} ${unrelatedSha}`;
            // merge-base returns something other than the parent — not an ancestor
            if (args[0] === 'merge-base') return differentMergeBase;
            return '';
        });

        await expect(hasMergeFromTarget(sourceBranch, targetBranch)).resolves.toBe(false);
    });

    it('continues after merge-base reports unrelated histories', async () => {
        gitCommandSpy.mockImplementation(async (args: string[]) => {
            if (args.includes('--merges')) return mergeSha;
            if (args.includes('--pretty=format:%P')) return `${branchParentSha} ${targetParentSha}`;
            if (args[0] === 'merge-base' && args[1] === branchParentSha) {
                throw Object.assign(new Error('no common ancestor'), { code: 1 });
            }
            if (args[0] === 'merge-base' && args[1] === targetParentSha) return targetParentSha;
            return '';
        });

        await expect(hasMergeFromTarget(sourceBranch, targetBranch)).resolves.toBe(true);
    });

    it('propagates unexpected Git failures', async () => {
        gitCommandSpy.mockImplementation(async (args: string[]) => {
            if (args.includes('--merges')) return mergeSha;
            if (args.includes('--pretty=format:%P')) return `${branchParentSha} ${targetParentSha}`;
            throw Object.assign(new Error('Git failed'), { code: 128 });
        });

        await expect(hasMergeFromTarget(sourceBranch, targetBranch)).rejects.toThrow('Git failed');
    });
});

describe('getBranchOnlyChangedFiles', () => {
    const sourceBranch = 'feature-branch';
    const targetBranch = 'main';

    let gitCommandSpy: MockInstance;

    beforeEach(() => {
        gitCommandSpy = vi.spyOn(Utils, 'runGitCommand');
    });

    it('should return files touched by non-merge commits', async () => {
        gitCommandSpy.mockResolvedValue('README.md\n\nactors/foo_bar/src/main.ts\n');

        const result = await getBranchOnlyChangedFiles(sourceBranch, targetBranch);

        expect(result).toStrictEqual(['README.md', 'actors/foo_bar/src/main.ts']);
        expect(gitCommandSpy).toHaveBeenCalledWith([
            'log',
            '--no-merges',
            '--name-only',
            '--pretty=format:',
            `${targetBranch}..${sourceBranch}`,
        ]);
    });

    it('should return empty array when there are no non-merge commits', async () => {
        gitCommandSpy.mockResolvedValue('');

        await expect(getBranchOnlyChangedFiles(sourceBranch, targetBranch)).resolves.toStrictEqual([]);
    });
});

const VALID_SHA = 'a'.repeat(40);
const VALID_JSON = JSON.stringify({ sha: VALID_SHA, author: 'test', date: 'now', message: 'msg' });

describe('parseBaseCommit', () => {
    it('should return undefined for undefined input', () => {
        expect(parseBaseCommit(undefined)).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
        expect(parseBaseCommit('')).toBeUndefined();
    });

    it('should accept a plain SHA string', () => {
        expect(parseBaseCommit(VALID_SHA)).toBe(VALID_SHA);
    });

    it('should extract sha from a JSON commit object', () => {
        expect(parseBaseCommit(VALID_JSON)).toBe(VALID_SHA);
    });

    it('should throw on an invalid SHA string', () => {
        expect(() => parseBaseCommit('not-a-sha')).toThrow('Invalid base commit SHA');
    });

    it('should throw when JSON contains an invalid sha field', () => {
        const badJson = JSON.stringify({ sha: 'bad', author: 'test', date: 'now', message: 'msg' });
        expect(() => parseBaseCommit(badJson)).toThrow('Invalid base commit SHA');
    });
});

describe('getCurrentBranch', () => {
    it('should return the checked-out branch', async () => {
        const gitCommandSpy = vi.spyOn(Utils, 'runGitCommand').mockResolvedValue('master');
        await expect(getCurrentBranch()).resolves.toBe('master');
        expect(gitCommandSpy).toHaveBeenCalledWith(['rev-parse', '--abbrev-ref', 'HEAD']);
    });

    it('should throw on a detached HEAD', async () => {
        vi.spyOn(Utils, 'runGitCommand').mockResolvedValue('HEAD');
        await expect(getCurrentBranch()).rejects.toThrow('HEAD is detached');
    });
});

describe('resolveRepoUrl', () => {
    it('reads and rewrites the origin URL when no URL is supplied', async () => {
        const gitCommandSpy = vi
            .spyOn(Utils, 'runGitCommand')
            .mockResolvedValue('https://github.com/apify/example.git');

        await expect(resolveRepoUrl(undefined)).resolves.toStrictEqual({
            repoUrl: 'git@github.com:apify/example.git',
            shouldVerifyRepoUrl: true,
        });
        expect(gitCommandSpy).toHaveBeenCalledWith(['remote', 'get-url', 'origin']);
    });

    it('uses an explicit URL without reading Git', async () => {
        const gitCommandSpy = vi.spyOn(Utils, 'runGitCommand');

        await expect(resolveRepoUrl('git@github.com:other/example.git')).resolves.toStrictEqual({
            repoUrl: 'git@github.com:other/example.git',
            shouldVerifyRepoUrl: false,
        });
        expect(gitCommandSpy).not.toHaveBeenCalled();
    });
});

describe('normalizeRepoUrl', () => {
    it.each([
        'git@github.com:Apify-Store/google-maps.git',
        'git@github.com:apify-store/google-maps',
        'https://github.com/apify-store/google-maps',
        'https://github.com/apify-store/google-maps.git/',
        'ssh://git@github.com/apify-store/google-maps',
        'git@github.com:apify-store/google-maps#master:actors/foo',
        'https://github.com/apify-store/google-maps#master',
    ])('should normalize %s', (url) => {
        expect(normalizeRepoUrl(url)).toBe('github.com/apify-store/google-maps');
    });

    it('should tell different repositories apart', () => {
        expect(normalizeRepoUrl('git@github.com:my-fork/google-maps.git')).not.toBe(
            normalizeRepoUrl('git@github.com:apify-store/google-maps.git'),
        );
    });
});

describe('getRepoName', () => {
    it('should return the repository name', () => {
        expect(getRepoName('git@github.com:apify-store/google-maps.git')).toBe('google-maps');
    });
});

describe('resolveReleaseBaseCommit', () => {
    const baseSha = 'b'.repeat(40);

    it('should return the base commit when it is an ancestor of HEAD', async () => {
        const gitCommandSpy = vi.spyOn(Utils, 'runGitCommand').mockImplementation(async (args: string[]) => {
            if (args[0] === 'rev-parse') return baseSha;
            if (args[0] === 'merge-base') return baseSha;
            return '';
        });
        await expect(resolveReleaseBaseCommit(baseSha)).resolves.toBe(baseSha);
        expect(gitCommandSpy).toHaveBeenCalledWith(['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`]);
        expect(gitCommandSpy).toHaveBeenCalledWith(['merge-base', baseSha, 'HEAD']);
    });

    it('should throw on the all-zeros SHA of a newly created branch', async () => {
        const spy = vi.spyOn(Utils, 'runGitCommand');
        await expect(resolveReleaseBaseCommit('0'.repeat(40))).rejects.toThrow('the branch was just created');
        expect(spy).not.toHaveBeenCalled();
    });

    it('should throw when the base commit is missing from the local history', async () => {
        const spy = vi
            .spyOn(Utils, 'runGitCommand')
            .mockRejectedValue(Object.assign(new Error('missing'), { code: 1 }));
        await expect(resolveReleaseBaseCommit(baseSha)).rejects.toThrow('is not in the local git history');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should throw when rev-parse returns an empty result', async () => {
        const spy = vi.spyOn(Utils, 'runGitCommand').mockResolvedValue('');
        await expect(resolveReleaseBaseCommit(baseSha)).rejects.toThrow('is not in the local git history');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should throw when the base commit is not an ancestor of HEAD (force push)', async () => {
        vi.spyOn(Utils, 'runGitCommand').mockImplementation(async (args: string[]) => {
            if (args[0] === 'rev-parse') return baseSha;
            if (args[0] === 'merge-base') return 'c'.repeat(40);
            return '';
        });
        await expect(resolveReleaseBaseCommit(baseSha)).rejects.toThrow('is not an ancestor of HEAD');
    });

    it('should throw when merge-base reports no common ancestor', async () => {
        vi.spyOn(Utils, 'runGitCommand').mockImplementation(async (args: string[]) => {
            if (args[0] === 'rev-parse') return baseSha;
            throw Object.assign(new Error('no common ancestor'), { code: 1 });
        });
        await expect(resolveReleaseBaseCommit(baseSha)).rejects.toThrow('is not an ancestor of HEAD');
    });

    it('should propagate unexpected Git failures', async () => {
        vi.spyOn(Utils, 'runGitCommand').mockRejectedValue(Object.assign(new Error('Git failed'), { code: 128 }));
        await expect(resolveReleaseBaseCommit(baseSha)).rejects.toThrow('Git failed');
    });

    it('should throw on an invalid SHA', async () => {
        await expect(resolveReleaseBaseCommit('not-a-sha')).rejects.toThrow('Invalid base commit SHA');
    });
});

describe('getReleaseChanges', () => {
    const baseSha = 'b'.repeat(40);
    const headSha = 'd'.repeat(40);
    const mergedBranchCommit = `${'1'.repeat(40)}»¦«Dev<dev@example.com>»¦«Date1»¦«feat: branch change`;
    const mergeCommit = `${headSha}»¦«Dev<dev@example.com>»¦«Date2»¦«Merge pull request #1`;

    let gitCommandSpy: MockInstance;
    let gitLogSpy: MockInstance;

    beforeEach(() => {
        gitLogSpy = vi.spyOn(Utils, 'runGitCommand').mockResolvedValue(`${mergeCommit}\n${mergedBranchCommit}`);
        gitCommandSpy = vi.spyOn(Utils, 'spawnCommand').mockImplementation((cmd: string) => {
            if (cmd === 'git rev-parse HEAD') return headSha;
            if (cmd.startsWith('git diff --name-only')) return 'actors/foo/src/main.ts\nCHANGELOG.md';
            if (cmd === 'git')
                return 'diff --git a/CHANGELOG.md b/CHANGELOG.md\n--- a/CHANGELOG.md\n+++ b/CHANGELOG.md\n@@ -1 +1,2 @@\n+- Added foo\n # Changelog';
            return '';
        });
    });

    it('should diff the range directly and return the commits oldest first', async () => {
        const changes = await getReleaseChanges(baseSha);

        expect(changes).toStrictEqual({
            commits: [
                { sha: '1'.repeat(40), author: 'Dev<dev@example.com>', date: 'Date1', message: 'feat: branch change' },
                { sha: headSha, author: 'Dev<dev@example.com>', date: 'Date2', message: 'Merge pull request #1' },
            ],
            changedFiles: ['actors/foo/src/main.ts', 'CHANGELOG.md'],
            changelog: '- Added foo',
        });
        // Not from the parent of the oldest commit, which may predate the base commit for merge commits
        expect(gitCommandSpy).toHaveBeenCalledWith(`git diff --name-only ${baseSha} HEAD`);
        expect(gitLogSpy).toHaveBeenCalledWith(['log', '--pretty=format:%H»¦«%aN<%aE>»¦«%aD»¦«%s', `${baseSha}..HEAD`]);
    });

    it('should return null when HEAD is the base commit', async () => {
        await expect(getReleaseChanges(headSha)).resolves.toBeNull();
        expect(gitLogSpy).not.toHaveBeenCalled();
    });
});
