import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const compilerPath = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));
let cliPath: string;
let buildDir: string | undefined;

const run = (command: string[], input: string, env: NodeJS.ProcessEnv = process.env) =>
    spawnSync(cliPath, command, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env });
const runBuild = (input: string, args: string[] = ['--version-number', '0.99']) => run(['build', ...args], input);

describe('build and notify-release CLI', () => {
    beforeAll(async () => {
        buildDir = await mkdtemp(path.join(projectRoot, '.cli-test-'));
        execFileSync(process.execPath, [compilerPath, '--outDir', buildDir], { cwd: projectRoot });
        cliPath = path.join(buildDir, 'bin/main.js');
        await chmod(cliPath, 0o755);
    });

    afterAll(async () => {
        if (buildDir) await rm(buildDir, { recursive: true, force: true });
    });

    it('builds nothing for an empty list and prints an empty build list', () => {
        const result = runBuild('{"actors":[]}');
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toStrictEqual([]);
    });

    it('fails on empty stdin instead of building nothing', () => {
        const result = runBuild('');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Expected the Actors to build as JSON on stdin, got nothing');
        expect(result.stdout).toBe('');
    });

    it('rejects a malformed --version-number', () => {
        const result = runBuild('{"actors":[]}', ['--version-number', 'latest']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('--version-number must look like 0.1 or be "default"');
    });

    it('requires --version-number', () => {
        const result = runBuild('{"actors":[]}', []);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Missing required argument: version-number');
    });

    it('notify-release announces nothing when there are no new commits', () => {
        const document = { commits: [], changedFiles: [], changelog: null, functionallyChangedActors: [] };
        const result = run(['notify-release'], JSON.stringify(document));
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain('No new commits, so there is no release to announce');
    });

    it('notify-release in a dry run logs the announcement without posting it', () => {
        const commit = { sha: '1'.repeat(40), author: 'Dev<dev@example.com>', date: 'Date', message: 'feat: foo' };
        const document = { commits: [commit], changedFiles: ['src/main.ts'], changelog: '- Added foo' };
        const result = run(
            [
                'notify-release',
                '--dry-run',
                '--repo-url',
                'git@github.com:owner/my-repo',
                '--report-slack-channel',
                '#r',
            ],
            JSON.stringify(document),
            { ...process.env, SLACK_TOKEN_RELEASES_BOT: 'not-used-in-a-dry-run' },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain('*my-repo* – New release (by Dev)');
        expect(result.stderr).toContain('1. Commit message: feat: foo');
    });
});
