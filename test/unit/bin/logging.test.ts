import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('../../../bin/main.ts', import.meta.url));
let workspace: string;
let sha: string;

describe('CLI logging', () => {
    beforeAll(async () => {
        workspace = await mkdtemp(path.join(os.tmpdir(), 'apify-cli-logging-'));
        const git = (...args: string[]) =>
            execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
                cwd: workspace,
                encoding: 'utf8',
            }).trim();
        git('init', '--quiet', '--initial-branch=base');
        git(
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '--quiet',
            '--allow-empty',
            '-m',
            'base',
        );
        git('checkout', '--quiet', '-b', 'feature');
        git(
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '--quiet',
            '--allow-empty',
            '-m',
            'feature',
        );
        sha = git('rev-parse', 'HEAD');
    });

    afterAll(async () => {
        await rm(workspace, { recursive: true, force: true });
    });

    it.each(['info', 'silent'])('keeps JSON results intact with --log-level %s', (level) => {
        const result = spawnSync(
            process.execPath,
            [
                '--import',
                'tsx',
                cliPath,
                'get-commits',
                '--workspace',
                workspace,
                '--source-branch',
                'feature',
                '--target-branch',
                'base',
                '--log-level',
                level,
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toEqual(level === 'silent' ? '' : expect.stringContaining('Commits being returned:'));
        expect(JSON.parse(result.stdout)).toMatchObject([{ sha, date: expect.any(String), message: 'feature' }]);
        expect(result.stdout.endsWith('\n')).toBe(true);
    });
});
