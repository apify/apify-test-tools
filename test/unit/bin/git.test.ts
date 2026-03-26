import type { MockInstance } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getChangedFiles, getCommits, parseBaseCommit } from '../../../bin/git.js';
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
        gitCommandSpy = vi
            .spyOn(Utils, 'spawnCommandInGhWorkspace')
            .mockReturnValue(`${commit3}\n${commit2}\n${commit1}`);
    });

    it('should return commits between source and target branches', () => {
        // Act
        const commits = getCommits({ sourceBranch, targetBranch });

        // Assert
        expect(commits).toStrictEqual([
            { sha: sha1, author: 'Author1', date: 'Date1', message: 'First Change On Feature' },
            { sha: sha2, author: 'Author1', date: 'Date2', message: 'Second Change On Feature' },
            { sha: sha3, author: 'Author1', date: 'Date3', message: 'Third Change On Feature' },
        ]);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith(
            `git log --pretty=format:'%H»¦«%aN<%aE>»¦«%aD»¦«%s' main..feature-branch`,
        );
    });

    it('should return commits after the base commit if provided', () => {
        // Act
        const commits = getCommits({ sourceBranch, targetBranch, baseCommit: sha1 });

        // Assert
        expect(commits).toStrictEqual([
            { sha: sha2, author: 'Author1', date: 'Date2', message: 'Second Change On Feature' },
            { sha: sha3, author: 'Author1', date: 'Date3', message: 'Third Change On Feature' },
        ]);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith(
            `git log --pretty=format:'%H»¦«%aN<%aE>»¦«%aD»¦«%s' main..feature-branch`,
        );
    });

    it('should return all commits if base commit is not found', () => {
        // Act
        const commits = getCommits({ sourceBranch, targetBranch, baseCommit: 'a'.repeat(40) });

        // Assert
        expect(commits).toStrictEqual([
            { sha: sha1, author: 'Author1', date: 'Date1', message: 'First Change On Feature' },
            { sha: sha2, author: 'Author1', date: 'Date2', message: 'Second Change On Feature' },
            { sha: sha3, author: 'Author1', date: 'Date3', message: 'Third Change On Feature' },
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
        const firstSha = '1'.repeat(40);
        const lastSha = '3'.repeat(40);
        const commits = [
            { sha: firstSha, author: '', date: '', message: '' },
            { sha: lastSha, author: '', date: '', message: '' },
        ];

        // Act
        const changedFiles = getChangedFiles(commits);

        // Assert
        expect(changedFiles).toStrictEqual(['file1.txt', 'folder/file2.txt']);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith(`git diff --name-only ${firstSha}~..${lastSha}`);
    });

    it('should handle only one commit', () => {
        // Arrange
        const onlySha = '1'.repeat(40);
        const commits = [{ sha: onlySha, author: '', date: '', message: '' }];

        // Act
        const changedFiles = getChangedFiles(commits);

        // Assert
        expect(changedFiles).toStrictEqual(['file1.txt', 'folder/file2.txt']);

        expect(gitCommandSpy).toHaveBeenCalledTimes(1);
        expect(gitCommandSpy).toHaveBeenCalledWith(`git diff --name-only ${onlySha}~..${onlySha}`);
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
