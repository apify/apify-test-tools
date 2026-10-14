import { describe, expect, it } from 'vitest';

import { GitCommandError, runGitCommand } from '../../../bin/utils.js';

describe('runGitCommand', () => {
    it('returns trimmed Git output without requiring a repository', async () => {
        await expect(runGitCommand(['--version'])).resolves.toMatch(/^git version /);
    });

    it('wraps a Git failure with the command and operation', async () => {
        const error: unknown = await runGitCommand(['--definitely-invalid-option'], {
            operation: 'check error handling',
        }).catch((failure: unknown) => failure);

        expect(error).toBeInstanceOf(GitCommandError);
        if (error instanceof GitCommandError) {
            expect(error.exitCode).not.toBe(0);
            expect(error.message).toContain('Failed to check error handling.\n');
            expect(error.message).toContain('Command: git "--definitely-invalid-option"\n');
            expect(error.gitError).toContain('--definitely-invalid-option');
            expect(error.cause).toBeInstanceOf(Error);
        }
    });

    it('passes arguments literally instead of running them through a shell', async () => {
        await expect(runGitCommand(['--version; echo injected'])).rejects.toThrow(
            'Command: git "--version; echo injected"\nGit error:',
        );
    });
});
