import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const vitestPath = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

// The test files that run real git commands in temp repos.
const GIT_TOUCHING_TESTS = ['test/unit/bin/build-from-local.test.ts'];

// Without any GIT_* or VITEST* variables, so neither the decoy setup nor the nested run sees ours.
const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && !name.startsWith('VITEST')),
);

const git = (cwd: string, args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
        cwd,
        env: baseEnv,
        stdio: 'pipe',
    });

const snapshotDir = async (dir: string): Promise<Record<string, string>> => {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
    const contents = await Promise.all(files.map(async (file) => fs.readFile(file, 'base64')));
    return Object.fromEntries(files.map((file, i) => [path.relative(dir, file), contents[i]]));
};

describe('git environment isolation', () => {
    let tempDir: string;
    let decoyGitDir: string;
    let worktreeGitDir: string;

    beforeAll(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apify-test-tools-decoy-'));
        const decoyRepo = path.join(tempDir, 'main');
        await fs.mkdir(decoyRepo);
        git(decoyRepo, ['init', '-q']);
        git(decoyRepo, ['commit', '-q', '--allow-empty', '-m', 'decoy']);
        git(decoyRepo, ['worktree', 'add', '-q', '--detach', path.join(tempDir, 'worktree')]);
        decoyGitDir = path.join(decoyRepo, '.git');
        worktreeGitDir = path.join(decoyGitDir, 'worktrees', 'worktree');
    });

    afterAll(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    // A pre-commit hook run from a linked worktree gets exactly these two variables from git.
    it('leaves the repository of a hook run from a linked worktree untouched', async () => {
        const before = await snapshotDir(decoyGitDir);

        const result = spawnSync(process.execPath, [vitestPath, 'run', ...GIT_TOUCHING_TESTS], {
            cwd: projectRoot,
            env: { ...baseEnv, GIT_DIR: worktreeGitDir, GIT_INDEX_FILE: path.join(worktreeGitDir, 'index') },
            encoding: 'utf8',
        });

        expect(result.status, result.stdout + result.stderr).toBe(0);
        // The config first, for a readable diff: a re-init there sets core.bare = true.
        expect(await fs.readFile(path.join(decoyGitDir, 'config'), 'utf8')).toBe(
            Buffer.from(before.config, 'base64').toString('utf8'),
        );
        expect(await snapshotDir(decoyGitDir)).toStrictEqual(before);
    }, 120_000);
});
