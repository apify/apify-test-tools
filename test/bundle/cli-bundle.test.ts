import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Runs the committed bundle the composite action ships, not the sources, so these catch anything
// that only breaks once bundled (a dependency loading code at runtime, a missing shim). Everything
// here works without tokens or network: read-only commands, dry runs that end up with nothing to
// build, and the missing-token error. The `CLI bundle` check keeps the bundle in sync with bin/.
const bundlePath = fileURLToPath(new URL('../../.github/cli/apify-test-tools.mjs', import.meta.url));

// Only what node and git need, so no Apify or Slack token from the developer's shell leaks in.
const cliEnv = { PATH: process.env.PATH ?? '', HOME: os.tmpdir() };
const gitEnv = {
    ...cliEnv,
    GIT_AUTHOR_NAME: 'Tester',
    GIT_AUTHOR_EMAIL: 'tester@example.com',
    GIT_COMMITTER_NAME: 'Tester',
    GIT_COMMITTER_EMAIL: 'tester@example.com',
};

let repoDir: string;
let baseSha: string;
let headSha: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, env: gitEnv, encoding: 'utf8' }).trim();

const writeRepoFile = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(repoDir, file)), { recursive: true });
    await writeFile(path.join(repoDir, file), content);
};

const runCli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [bundlePath, ...args], { cwd: repoDir, env: cliEnv, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const gitRange = ['--source-branch', 'feature', '--target-branch', 'main'];

describe('CLI bundle', () => {
    // Two Actors on `main`; `feature` changes only tester/foo and the root README.
    beforeAll(async () => {
        repoDir = await mkdtemp(path.join(os.tmpdir(), 'apify-cli-bundle-'));
        git('init', '-q', '-b', 'main');
        git('remote', 'add', 'origin', 'https://github.com/apify/fixture-repo.git');
        for (const name of ['foo', 'bar']) {
            await writeRepoFile(
                `actors/${name}/.actor/actor.json`,
                JSON.stringify({ actorSpecification: 1, name, version: '0.1' }),
            );
        }
        await writeRepoFile(
            'apify-test-tools.config.json',
            JSON.stringify({
                actors: [
                    { folder: 'actors/foo', actorFullName: 'tester/foo', tokenEnvVar: 'FOO_TOKEN' },
                    { folder: 'actors/bar', actorFullName: 'tester/bar', tokenEnvVar: 'BAR_TOKEN' },
                ],
            }),
        );
        git('add', '-A');
        git('commit', '-q', '-m', 'chore: init');
        baseSha = git('rev-parse', 'HEAD');

        git('checkout', '-q', '-b', 'feature');
        await writeRepoFile('actors/foo/main.js', 'console.log("changed");\n');
        git('add', '-A');
        git('commit', '-q', '-m', 'fix(foo): change foo');
        await writeRepoFile('README.md', 'readme\n');
        git('add', '-A');
        git('commit', '-q', '-m', 'docs: readme');
        headSha = git('rev-parse', 'HEAD');
    });

    afterAll(async () => {
        if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    it('lists every command in --help', () => {
        const { status, stdout } = runCli('--help');
        expect(status).toBe(0);
        for (const command of [
            'get-commits',
            'get-latest-commit',
            'get-changed-files',
            'get-actor-configs',
            'get-affected-actors',
            'report-tests',
            'build',
            'release',
            'build-from-local',
            'delete-old-builds',
        ]) {
            expect(stdout).toContain(command);
        }
    });

    it('get-commits returns the commits on the source branch', () => {
        const { status, stdout, stderr } = runCli('get-commits', ...gitRange);
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout).map((commit: { message: string }) => commit.message)).toEqual([
            'fix(foo): change foo',
            'docs: readme',
        ]);
    });

    it('get-latest-commit returns the head of the source branch', () => {
        const { status, stdout, stderr } = runCli('get-latest-commit', ...gitRange);
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({ sha: headSha, message: 'docs: readme' });
    });

    it('get-changed-files returns the files changed on the source branch', () => {
        const { status, stdout, stderr } = runCli('get-changed-files', ...gitRange);
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout)).toEqual(['README.md', 'actors/foo/main.js']);
    });

    it('get-actor-configs reads both Actors from the config file', () => {
        const { status, stdout, stderr } = runCli('get-actor-configs');
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout).map((actor: { actorFullName: string }) => actor.actorFullName)).toEqual([
            'tester/foo',
            'tester/bar',
        ]);
    });

    it('get-affected-actors returns only the Actor whose files changed', () => {
        const { status, stdout, stderr } = runCli('get-affected-actors', ...gitRange);
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject([{ actorFullName: 'tester/foo', folder: 'actors/foo' }]);
    });

    it('build --dry-run with nothing to build needs no token', () => {
        const { status, stdout, stderr } = runCli('build', ...gitRange, '--actors', 'tester/bar', '--dry-run');
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout)).toEqual({ dryRun: true, builds: [] });
    });

    it('build --dry-run fails cleanly when the Actor token is missing', () => {
        const { status, stderr } = runCli('build', ...gitRange, '--dry-run');
        expect(status).toBe(1);
        expect(stderr).toContain('Env var FOO_TOKEN is not set (needed for actor "tester/foo")');
    });

    it('release --dry-run stops when HEAD is the base commit', () => {
        const { status, stderr } = runCli('release', '--base-commit', headSha, '--dry-run');
        expect(status, stderr).toBe(0);
        expect(stderr).toContain(`HEAD is the base commit ${headSha}, there is nothing new to release`);
    });

    it('release --dry-run with nothing to build skips Slack without a token', () => {
        const { status, stderr } = runCli('release', '--base-commit', baseSha, '--actors', 'tester/bar', '--dry-run');
        expect(status, stderr).toBe(0);
        expect(stderr).toContain('{"dryRun":true,"builds":[]}');
        expect(stderr).toContain('Skipping slack notification');
    });

    it('report-tests summarizes a vitest JSON report', async () => {
        const assertion = (title: string, status: 'passed' | 'failed', runId: string) => ({
            ancestorTitles: [],
            fullName: `foo ${title}`,
            title,
            status,
            failureMessages: status === 'failed' ? ['AssertionError: expected 1 to be 2\n    at foo.test.ts:1:1'] : [],
            meta: { runId, runLink: `https://console.apify.com/view/runs/${runId}`, actorId: 'tester/foo' },
        });
        await writeRepoFile(
            'test-output.json',
            JSON.stringify({
                success: false,
                testResults: [
                    {
                        name: 'test/platform/foo.test.ts',
                        status: 'failed',
                        assertionResults: [assertion('works', 'passed', 'run1'), assertion('fails', 'failed', 'run2')],
                    },
                ],
            }),
        );

        const { status, stderr } = runCli('report-tests', '--report-file', 'test-output.json', '--dry-run');
        expect(status, stderr).toBe(0);
        expect(stderr).toContain('PASSED: 1, FAILED: 1');
        expect(stderr).toContain('1) foo fails ... https://console.apify.com/view/runs/run2');
        expect(stderr).toContain('Skipping slack notification');
    });
});
