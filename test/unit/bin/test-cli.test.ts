import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compileCli } from './compiled-cli.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

let cliPath: string;
let cleanup: (() => Promise<void>) | undefined;
let repoDir: string;

// Only what node needs, so the outer vitest's own variables don't reach the inner one. The fixture's tests never call
// Apify, so any token does.
const env = { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), TESTER_APIFY_TOKEN: 'fake-token' };

const run = (args: string[], input = '', cwd = repoDir, runEnv: NodeJS.ProcessEnv = env) =>
    spawnSync(cliPath, args, { cwd, encoding: 'utf8', input, env: runEnv, stdio: ['pipe', 'pipe', 'pipe'] });

const build = { buildId: 'b1', actorRawId: 'raw1', buildNumber: '0.99.1', actorFullName: 'owner/a' };

// A consumer repository with the vitest it installed: one passing test that started a run, one failing
describe('test CLI', () => {
    beforeAll(async () => {
        ({ cliPath, cleanup } = await compileCli());
        repoDir = await mkdtemp(path.join(os.tmpdir(), 'apify-test-cli-'));
        await symlink(path.join(projectRoot, 'node_modules'), path.join(repoDir, 'node_modules'), 'dir');
        await mkdir(path.join(repoDir, 'test/platform'), { recursive: true });
        await writeFile(
            path.join(repoDir, 'test/platform/a.test.ts'),
            `import { expect, test } from 'vitest';

test('owner/a: works', ({ task }) => {
    console.log('ENV', process.env.ACTOR_BUILDS ?? '-', process.env.RUN_ALL_PLATFORM_TESTS ?? '-');
    task.meta = { runId: 'run1', runLink: 'https://console.apify.com/view/runs/run1', actorId: 'owner/a' } as never;
});

test('owner/a: fails', () => {
    expect(1).toBe(2);
});
`,
        );
    });

    afterAll(async () => {
        await cleanup?.();
        if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    it('tests the builds on stdin, printing the report on stdout and the vitest output on stderr', () => {
        const result = run(['test'], JSON.stringify([build]));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`ENV ${JSON.stringify([build])} -`);
        expect(result.stderr).toContain('1) owner/a: works ... https://console.apify.com/view/runs/run1');
        // Vitest's own output still comes through, without the note about the temporary JSON report
        expect(result.stderr).toContain('Test Files');
        expect(result.stderr).not.toContain('JSON report written to');
        expect(JSON.parse(result.stdout)).toMatchObject({
            version: 1,
            success: false,
            summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
            tests: [
                { name: 'owner/a: works', file: 'test/platform/a.test.ts', status: 'passed', run: { runId: 'run1' } },
                { name: 'owner/a: fails', status: 'failed', failureMessages: [expect.stringContaining('expected 1')] },
            ],
            errors: [],
        });
    });

    it('tests every Actor with --all, without reading stdin', () => {
        const result = run(['test', '--all']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('ENV - 1');
        expect(JSON.parse(result.stdout)).toMatchObject({ success: false, summary: { passed: 1, failed: 1 } });
    });

    it('adds the reporters it is given to the default and JSON ones, also before the test files', () => {
        const result = run([
            '--log-level',
            'debug',
            'test',
            '--all',
            '--reporter',
            'dot',
            '--reporter',
            'verbose',
            'test/platform',
        ]);
        expect(result.stderr).toMatch(
            /Running vitest: \S+ run test\/platform --reporter=default --reporter=json --reporter=dot --reporter=verbose /,
        );
        expect(JSON.parse(result.stdout)).toMatchObject({ summary: { passed: 1, failed: 1 } });
    });

    it('fails without TESTER_APIFY_TOKEN instead of passing with every test skipped', () => {
        const result = run(['test'], JSON.stringify([build]), repoDir, { ...env, TESTER_APIFY_TOKEN: '' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('TESTER_APIFY_TOKEN is not set');
        expect(result.stdout).toBe('');
    });

    it('fails on empty stdin instead of testing nothing', () => {
        const result = run(['test']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Expected the builds to test as JSON on stdin, got nothing');
        expect(result.stdout).toBe('');
    });

    it('fails clearly where vitest is not installed', async () => {
        const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'apify-test-cli-empty-'));
        try {
            const result = run(['test', '--all'], '', emptyDir);
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('vitest is not installed');
        } finally {
            await rm(emptyDir, { recursive: true, force: true });
        }
    });

    it('hands the report to notify', () => {
        const report = run(['test'], JSON.stringify([build])).stdout;
        const result = run(['notify'], report);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain('Skipping notification, no --slack-channel passed');
    });
});
