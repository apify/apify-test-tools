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

const runCliWithInput = (input: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [bundlePath, ...args], {
        cwd: repoDir,
        env: cliEnv,
        encoding: 'utf8',
        input,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const runCli = (...args: string[]) => runCliWithInput('', ...args);

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
            'test [filters..]',
            'notify',
            'build',
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
        // `feature` is checked out, and the range always ends at HEAD
        const { status, stdout, stderr } = runCli('get-affected-actors', '--base', 'main');
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({
            version: 1,
            head: headSha,
            functionallyChangedActors: [{ actorFullName: 'tester/foo' }],
            // The root README isn't in tester/bar's folder, so it doesn't count for it
            cosmeticallyChangedActors: [],
        });
    });

    it('build --dry-run with nothing to build needs no token', () => {
        const { status, stdout, stderr } = runCliWithInput(
            JSON.stringify({ actors: [] }),
            'build',
            '--version-number',
            '0.99',
            '--dry-run',
        );
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout)).toEqual({ dryRun: true, builds: [] });
    });

    it('build --dry-run fails cleanly when the Actor token is missing', () => {
        const { status, stderr } = runCliWithInput(
            JSON.stringify({ actors: [{ actorFullName: 'tester/foo' }] }),
            'build',
            '--version-number',
            '0.99',
            '--dry-run',
        );
        expect(status).toBe(1);
        expect(stderr).toContain('Env var FOO_TOKEN is not set (needed for actor "tester/foo")');
    });

    it('build fails on empty input instead of building nothing', () => {
        const { status, stderr } = runCli('build', '--version-number', '0.99', '--dry-run');
        expect(status).toBe(1);
        expect(stderr).toContain('got nothing');
    });

    it('get-affected-actors --since HEAD reports nothing', () => {
        const { status, stdout, stderr } = runCli('get-affected-actors', '--since', headSha);
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({
            commits: [],
            functionallyChangedActors: [],
            cosmeticallyChangedActors: [],
        });
    });

    it('notify announces no release, and needs no token, when there are no new commits', () => {
        const affected = runCli('get-affected-actors', '--since', headSha).stdout;
        const { status, stderr } = runCliWithInput(affected, 'notify', '--slack-changelog-channel', '#releases');
        expect(status, stderr).toBe(0);
        expect(stderr).toContain('No new commits, so there is no release to announce');
    });

    it('notify skips a release without a channel', () => {
        const affected = runCli('get-affected-actors', '--since', baseSha).stdout;
        const { status, stderr } = runCliWithInput(affected, 'notify', '--dry-run');
        expect(status, stderr).toBe(0);
        expect(stderr).toContain('Skipping notification, no --slack-channel or --slack-changelog-channel passed');
    });

    it('test fails clearly where vitest is not installed', () => {
        const { status, stdout, stderr } = runCli('test', '--all');
        expect(status).toBe(1);
        expect(stderr).toContain('vitest is not installed');
        expect(stdout).toBe('');
    });

    it('notify needs the Slack token to post a failed report, even in a dry run', () => {
        const report = {
            version: 1,
            success: false,
            summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
            tests: [
                {
                    name: 'tester/foo: fails',
                    file: 'test/platform/foo.test.ts',
                    status: 'failed',
                    durationMs: 1,
                    failureMessages: ['AssertionError: expected 1 to be 2'],
                    run: { actorId: 'tester/foo', runId: 'run2', runLink: 'https://console.apify.com/view/runs/run2' },
                },
            ],
            errors: [],
        };
        const withChannel = runCliWithInput(JSON.stringify(report), 'notify', '--slack-channel', '#notif', '--dry-run');
        expect(withChannel.status).toBe(1);
        expect(withChannel.stderr).toContain('SLACK_TOKEN_TESTS_BOT not defined');

        const withoutChannel = runCliWithInput(JSON.stringify(report), 'notify', '--dry-run');
        expect(withoutChannel.status, withoutChannel.stderr).toBe(0);
        expect(withoutChannel.stderr).toContain('Skipping notification');
    });
});
