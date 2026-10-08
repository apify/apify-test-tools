import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getGitignoredPaths, GitCommandError, listRepoFilePaths, runGitCommand } from '../../../bin/utils.js';

describe('runGitCommand', () => {
    it('returns trimmed Git output', async () => {
        await expect(runGitCommand(['rev-parse', '--is-inside-work-tree'], { cwd: process.cwd() })).resolves.toBe(
            'true',
        );
    });

    it('rejects on git exit code, not stderr', async () => {
        const error: unknown = await runGitCommand(['rev-parse', '--verify', '--quiet'], {
            cwd: process.cwd(),
            operation: 'verify a commit',
        }).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(GitCommandError);
        if (error instanceof GitCommandError) {
            expect(error.exitCode).toBe(1);
            expect(error.gitError).toContain('Command failed: git rev-parse --verify --quiet');
            expect(error.message).toContain('Failed to verify a commit.\nCommand:');
            expect(error.stack).toContain('Failed to verify a commit.');
            expect(error.cause).toBeInstanceOf(Error);
        }
    });

    it('passes arguments literally and rejects Git failures', async () => {
        await expect(runGitCommand(['rev-parse', '--verify', 'HEAD; echo injected'])).rejects.toThrow(
            'Command: git "rev-parse" "--verify" "HEAD; echo injected"\nGit error:',
        );
    });
});

describe('listRepoFilePaths', () => {
    it('lists files under a subdirectory relative to the repository root', async () => {
        const repoRoot = process.cwd();
        await expect(listRepoFilePaths(repoRoot, path.join(repoRoot, 'bin'))).resolves.toContain('bin/utils.ts');
    });
});

describe('getGitignoredPaths', () => {
    it('returns an empty set for no paths', async () => {
        await expect(getGitignoredPaths([])).resolves.toStrictEqual(new Set());
    });

    it('returns only paths ignored by the repository rules', async () => {
        await expect(
            getGitignoredPaths(['node_modules/example.js', 'bin/utils.ts', '.DS_Store'], process.cwd()),
        ).resolves.toStrictEqual(new Set(['node_modules/example.js', '.DS_Store']));
    });

    it('returns an empty set when Git exits with code 1', async () => {
        await expect(getGitignoredPaths(['bin/utils.ts'], process.cwd())).resolves.toStrictEqual(new Set());
    });

    it('rejects unexpected Git errors', async () => {
        await expect(getGitignoredPaths(['bin/utils.ts'], os.tmpdir())).rejects.toThrow(
            'Failed to check which repository paths are ignored.\n' +
                'Command: git "check-ignore" "--" "bin/utils.ts"\n' +
                'Git error: fatal: not a git repository',
        );
    });
});
