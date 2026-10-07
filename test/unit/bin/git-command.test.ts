import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { listRepoFilePaths, runGitCommand } from '../../../bin/utils.js';

describe('runGitCommand', () => {
    it('returns trimmed Git output', async () => {
        await expect(runGitCommand(['rev-parse', '--is-inside-work-tree'], process.cwd())).resolves.toBe('true');
    });

    it('rejects on git exit code, not stderr', async () => {
        await expect(runGitCommand(['rev-parse', '--verify', '--quiet'], process.cwd())).rejects.toThrow();
    });

    it('passes arguments literally and rejects Git failures', async () => {
        await expect(runGitCommand(['rev-parse', '--verify', 'HEAD; echo injected'])).rejects.toThrow(
            'Command failed: git rev-parse --verify HEAD; echo injected',
        );
    });
});

describe('listRepoFilePaths', () => {
    it('lists files under a subdirectory relative to the repository root', async () => {
        const repoRoot = process.cwd();
        await expect(listRepoFilePaths(repoRoot, path.join(repoRoot, 'bin'))).resolves.toContain('bin/utils.ts');
    });
});
