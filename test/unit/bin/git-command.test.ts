import { describe, expect, it } from 'vitest';

import { runGitCommand } from '../../../bin/utils.js';

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
