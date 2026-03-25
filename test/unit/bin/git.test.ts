import type { MockInstance } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getChangedFiles, getCommits } from '../../../bin/git.js';
import * as Utils from '../../../bin/utils.js';

describe('getCommits', () => {
    const sourceBranch = 'feature-branch';
    const targetBranch = 'main';

    const commit1 = 'Commit1»¦«Author1»¦«Date1»¦«First Change On Feature';
    const commit2 = 'Commit2»¦«Author1»¦«Date2»¦«Second Change On Feature';
    const commit3 = 'Commit3»¦«Author1»¦«Date3»¦«Third Change On Feature';

    let gitCommandSpy: MockInstance;

    beforeEach(() => {
        gitCommandSpy = vi
            .spyOn(Utils, 'spawnCommandInGhWorkspace')
            .mockReturnValue(`${commit3}\n${commit2}\n${commit1}`);
    });

    it('should return commits between source and target branches', () => {
        // Act
        const commits = getCommits({ sourceBranch, targetBranch });

        // Assert
        expect(commits).toStrictEqual([
            { sha: 'Commit1', author: 'Author1', date: 'Date1', message: 'First Change On Feature' },
            { sha: 'Commit2', author: 'Author1', date: 'Date2', message: 'Second Change On Feature' },
            { sha: 'Commit3', author: 'Author1', date: 'Date3', message: 'Third Change On Feature' },
        ]);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith(
            `git log --pretty=format:'%H»¦«%aN<%aE>»¦«%aD»¦«%s' main..feature-branch`,
        );
    });

    it('should return commits after the base commit if provided', () => {
        // Act
        const commits = getCommits({ sourceBranch, targetBranch, baseCommit: 'Commit1' });

        // Assert
        expect(commits).toStrictEqual([
            { sha: 'Commit2', author: 'Author1', date: 'Date2', message: 'Second Change On Feature' },
            { sha: 'Commit3', author: 'Author1', date: 'Date3', message: 'Third Change On Feature' },
        ]);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith(
            `git log --pretty=format:'%H»¦«%aN<%aE>»¦«%aD»¦«%s' main..feature-branch`,
        );
    });

    it('should return all commits if base commit is not found', () => {
        // Act
        const commits = getCommits({ sourceBranch, targetBranch, baseCommit: 'NonExistingCommit' });

        // Assert
        expect(commits).toStrictEqual([
            { sha: 'Commit1', author: 'Author1', date: 'Date1', message: 'First Change On Feature' },
            { sha: 'Commit2', author: 'Author1', date: 'Date2', message: 'Second Change On Feature' },
            { sha: 'Commit3', author: 'Author1', date: 'Date3', message: 'Third Change On Feature' },
        ]);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith(
            `git log --pretty=format:'%H»¦«%aN<%aE>»¦«%aD»¦«%s' main..feature-branch`,
        );
    });
});

describe('getChangedFiles', () => {
    let gitCommandSpy: MockInstance;

    beforeEach(() => {
        gitCommandSpy = vi.spyOn(Utils, 'spawnCommandInGhWorkspace').mockReturnValue('file1.txt\nfolder/file2.txt');
    });

    it('should return changed files between commits', () => {
        // Arrange
        const commits = [
            { sha: 'Commit1', author: '', date: '', message: '' },
            { sha: 'Commit3', author: '', date: '', message: '' },
        ];

        // Act
        const changedFiles = getChangedFiles(commits);

        // Assert
        expect(changedFiles).toStrictEqual(['file1.txt', 'folder/file2.txt']);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith(`git diff --name-only Commit1~..Commit3`);
    });

    it('should handle only one commit', () => {
        // Arrange
        const commits = [{ sha: 'Commit1', author: '', date: '', message: '' }];

        // Act
        const changedFiles = getChangedFiles(commits);

        // Assert
        expect(changedFiles).toStrictEqual(['file1.txt', 'folder/file2.txt']);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith(`git diff --name-only Commit1~..Commit1`);
    });
});
