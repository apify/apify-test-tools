import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const vitestPath = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

const git = (cwd: string, args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' });

describe('git environment isolation', () => {
    let tempDir: string;

    beforeAll(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apify-test-tools-decoy-'));
        await fs.mkdir(path.join(tempDir, 'main'));
        git(path.join(tempDir, 'main'), ['init', '-q']);
        git(path.join(tempDir, 'main'), ['commit', '-q', '--allow-empty', '-m', 'decoy']);
        git(path.join(tempDir, 'main'), ['worktree', 'add', '-q', '--detach', path.join(tempDir, 'worktree')]);
    });

    afterAll(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    // A pre-commit hook run from a linked worktree gets exactly these two variables from git.
    it('leaves the repository of a hook run from a linked worktree untouched', async () => {
        const configPath = path.join(tempDir, 'main', '.git', 'config');
        const worktreeGitDir = path.join(tempDir, 'main', '.git', 'worktrees', 'worktree');
        const configBefore = await fs.readFile(configPath, 'utf8');

        const result = spawnSync(process.execPath, [vitestPath, 'run', 'test/unit/bin/build-from-local.test.ts'], {
            cwd: projectRoot,
            env: { ...process.env, GIT_DIR: worktreeGitDir, GIT_INDEX_FILE: path.join(worktreeGitDir, 'index') },
            encoding: 'utf8',
        });

        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(await fs.readFile(configPath, 'utf8')).toBe(configBefore);
    }, 120_000);
});
