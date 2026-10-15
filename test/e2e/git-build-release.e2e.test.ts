import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ApifyClient } from 'apify-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActorBuild } from './helpers.js';
import { gitEnv, runCli as runCliIn, token } from './helpers.js';

// Real git builds of a real repository: the shipped CLI bundle builds an Actor from a clone of
// apify-store/testing-repo-for-github-actions, and the Apify builder clones the same repository
// (over SSH, with the sandbox org's deploy key installed on it).
//
// The repo's `e2e/base` and `e2e/feature` branches are fixtures and never change: `e2e/feature`
// adds one commit touching only dummy-for-testing-1. Commands get `origin/` branch refs, the way
// the reusable workflows pass them. `release` rebuilds dummy-for-testing-1 under `latest` on every
// run, which is fine for a sandbox Actor nobody else uses.
//
// Runs with `npm run test:e2e`, kept out of `npm test`. Skipped without the token, e.g. on fork PRs.
const FIXTURE_REPO = 'https://github.com/apify-store/testing-repo-for-github-actions';
const BASE_BRANCH = 'e2e/base';
const FEATURE_BRANCH = 'e2e/feature';
const CHANGED_ACTOR = 'test-tools-testing-sandbox/dummy-for-testing-1';
const CHANGED_ACTOR_FOLDER = 'actors/dummy-for-testing-1';
// The CLI builds from the SSH form of the origin URL, which is what lets a deploy key work.
const BUILD_SOURCE = `git@github.com:apify-store/testing-repo-for-github-actions#${FEATURE_BRANCH}:${CHANGED_ACTOR_FOLDER}`;

const gitRange = ['--source-branch', `origin/${FEATURE_BRANCH}`, '--target-branch', `origin/${BASE_BRANCH}`];

let repoDir: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, env: gitEnv, encoding: 'utf8' }).trim();
const runCli = (...args: string[]) => runCliIn(repoDir, ...args);

describe.runIf(token)('CLI bundle building a real repository', { timeout: 2 * 60_000 }, () => {
    const client = new ApifyClient({ token });

    const versionSource = async (versionNumber: string) => {
        const actor = await client.actor(CHANGED_ACTOR).get();
        const version = actor?.versions.find(({ versionNumber: number }) => number === versionNumber);
        return version && 'gitRepoUrl' in version ? version.gitRepoUrl : undefined;
    };

    // A full clone checked out on the feature branch, like actions/checkout with fetch-depth: 0.
    beforeAll(async () => {
        repoDir = await mkdtemp(path.join(os.tmpdir(), 'apify-cli-e2e-git-'));
        execFileSync('git', ['clone', '-q', FIXTURE_REPO, repoDir], { env: gitEnv });
        git('checkout', '-q', '-b', FEATURE_BRANCH, `origin/${FEATURE_BRANCH}`);
    }, 5 * 60_000);

    afterAll(async () => {
        if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    it('get-affected-actors finds only the Actor the feature branch changed', () => {
        const { status, stdout, stderr } = runCli('get-affected-actors', ...gitRange);
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject([{ actorFullName: CHANGED_ACTOR, folder: CHANGED_ACTOR_FOLDER }]);
    });

    it('build builds the changed Actor from the feature branch', { timeout: 10 * 60_000 }, async () => {
        const { status, stdout, stderr } = runCli('build', ...gitRange, '--use-docker-cache');
        expect(status, stderr).toBe(0);
        const builds: ActorBuild[] = JSON.parse(stdout);
        expect(builds).toMatchObject([
            { actorFullName: CHANGED_ACTOR, buildNumber: expect.stringMatching(/^0\.99\.\d+$/) },
        ]);

        // `origin/` is stripped from the branch, or the builder couldn't check it out.
        expect(await versionSource('0.99')).toBe(BUILD_SOURCE);
        expect((await client.build(builds[0].buildId).get())?.status).toBe('SUCCEEDED');
    });

    it('release rebuilds the default version of the changed Actor', { timeout: 10 * 60_000 }, async () => {
        const baseSha = git('rev-parse', `origin/${BASE_BRANCH}`);
        const { status, stderr } = runCli('release', '--base-commit', baseSha, '--use-docker-cache');
        expect(status, stderr).toBe(0);
        expect(stderr).toMatch(new RegExp(`\\[${CHANGED_ACTOR}\\]: 0\\.0\\.\\d+`));
        expect(stderr).toContain('Skipping slack notification');

        // Releasing builds the default version from the branch being released.
        expect(await versionSource('0.0')).toBe(BUILD_SOURCE);
    });
});
