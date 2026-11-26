import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { ApifyClient } from 'apify-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { groupedConfig } from '../grouped-config.js';
import type { ActorBuild } from './helpers.js';
import {
    bundlePath,
    cliEnv,
    gitEnv,
    projectRoot,
    runCli as runCliIn,
    runCliWithInput as runCliWithInputIn,
    runProcess,
    token,
    TOKEN_ENV_VAR,
} from './helpers.js';

// End-to-end run of the shipped CLI bundle against two dummy Actors in an isolated sandbox account:
// dry-run plans read the real Actors, `build-from-local` really builds them, the lib runs them
// through `testActor` on exactly those builds (`build-from-local | test`), calls dummy-for-testing-2
// in standby through `testStandbyActor` on its build, `notify` reads the report, and
// `delete-old-builds` cleans up. Git builds of a real repository are in
// git-build-release.e2e.test.ts.
//
// Runs with `npm run test:e2e`, kept out of `npm test`. Skipped without the token, e.g. on fork PRs.
const ACTORS = ['test-tools-testing-sandbox/dummy-for-testing-1', 'test-tools-testing-sandbox/dummy-for-testing-2'];
// dummy-for-testing-2 doubles as a standby Actor
const STANDBY_ACTOR = ACTORS[1];
// Started normally it only logs; in standby it answers every request with the build serving it and what it got.
// A dynamic import works whether the image treats main.js as CommonJS or as an ES module.
const STANDBY_DUMMY_MAIN = `import('node:http').then(({ createServer }) => {
    if (process.env.APIFY_META_ORIGIN !== 'STANDBY') {
        console.log('dummy 2');
        return;
    }
    createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    buildId: process.env.ACTOR_BUILD_ID,
                    buildNumber: process.env.ACTOR_BUILD_NUMBER,
                    method: req.method,
                    path: req.url,
                    contentType: req.headers['content-type'],
                    body,
                }),
            );
        });
    }).listen(Number(process.env.ACTOR_STANDBY_PORT ?? process.env.ACTOR_WEB_SERVER_PORT));
});
`;
// Only used as the source URL in dry-run plans; nothing is cloned from it.
const REPO_URL = 'https://github.com/apify/apify-test-tools-e2e-fixture';

let repoDir: string;
let baseSha: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, env: gitEnv, encoding: 'utf8' }).trim();

const writeRepoFile = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(repoDir, file)), { recursive: true });
    await writeFile(path.join(repoDir, file), content);
};

const runCli = async (...args: string[]) => runCliIn(repoDir, ...args);
const runCliWithInput = async (input: string, ...args: string[]) => runCliWithInputIn(repoDir, input, ...args);

/** Lets the consumer's platform tests resolve vitest and the lib's dependencies the way an installed package would. */
const linkNodeModules = async () => {
    const link = path.join(repoDir, 'node_modules');
    if (await lstat(link).catch(() => null)) return;
    await symlink(path.join(projectRoot, 'node_modules'), link, 'dir');
};

describe.runIf(token)('CLI bundle against real Actors', { timeout: 2 * 60_000 }, () => {
    let builds: ActorBuild[];

    // Both Actors on `main`; `feature` changes only dummy-for-testing-1.
    beforeAll(async () => {
        repoDir = await mkdtemp(path.join(os.tmpdir(), 'apify-cli-e2e-'));
        git('init', '-q', '-b', 'main');
        git('remote', 'add', 'origin', `${REPO_URL}.git`);
        const actors = [];
        for (const [i, actorFullName] of ACTORS.entries()) {
            const folder = `actors/dummy-${i + 1}`;
            const standby = actorFullName === STANDBY_ACTOR;
            await writeRepoFile(
                `${folder}/.actor/actor.json`,
                JSON.stringify({
                    actorSpecification: 1,
                    name: actorFullName.split('/')[1],
                    version: '0.0',
                    dockerfile: '../Dockerfile',
                    ...(standby && { usesStandbyMode: true }),
                }),
            );
            await writeRepoFile(
                `${folder}/Dockerfile`,
                'FROM apify/actor-node:22\nCOPY . ./\nCMD ["node", "main.js"]\n',
            );
            await writeRepoFile(`${folder}/main.js`, standby ? STANDBY_DUMMY_MAIN : `console.log('dummy ${i + 1}');\n`);
            actors.push({ folder, actorFullName, tokenEnvVar: TOKEN_ENV_VAR });
        }
        await writeRepoFile('apify-test-tools.config.json', JSON.stringify(groupedConfig(actors)));
        git('add', '-A');
        git('commit', '-q', '-m', 'chore: init');
        baseSha = git('rev-parse', 'HEAD');

        git('checkout', '-q', '-b', 'feature');
        await writeRepoFile('actors/dummy-1/main.js', "console.log('dummy 1 changed');\n");
        git('add', '-A');
        git('commit', '-q', '-m', 'fix(dummy-1): change');
    });

    afterAll(async () => {
        if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    it('build --dry-run plans a test build of the Actors it is given', async () => {
        const { status, stdout, stderr } = await runCliWithInput(
            JSON.stringify({ actors: [{ actorFullName: ACTORS[0] }] }),
            'build',
            '--version-number',
            '0.99',
            '--repo-url',
            REPO_URL,
            '--dry-run',
        );
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout)).toEqual({
            dryRun: true,
            builds: [
                { actorFullName: ACTORS[0], versionNumber: '0.99', gitRepoUrl: `${REPO_URL}#feature:actors/dummy-1` },
            ],
        });
    });

    it('a release pipeline plans a build of the default version of every changed Actor', async () => {
        const affected = await runCli('get-affected-actors', '--since', baseSha);
        expect(affected.status, affected.stderr).toBe(0);
        const { functionallyChangedActors, cosmeticallyChangedActors } = JSON.parse(affected.stdout);

        const { status, stderr } = await runCliWithInput(
            JSON.stringify({ actors: [...functionallyChangedActors, ...cosmeticallyChangedActors] }),
            'build',
            '--version-number',
            'default',
            '--repo-url',
            REPO_URL,
            '--dry-run',
        );
        expect(status, stderr).toBe(0);
        expect(stderr).toContain(
            `[DRY RUN] Would build:\n  ${ACTORS[0]} (0.0) from ${REPO_URL}#feature:actors/dummy-1`,
        );
    });

    it('build-from-local --dry-run plans both Actors from the working tree', async () => {
        const { status, stdout, stderr } = await runCli('build-from-local', '--dry-run');
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({
            dryRun: true,
            builds: ACTORS.map((actorFullName) => ({ actorFullName, versionNumber: '0.98', fileCount: 3 })),
        });
    });

    it('build-from-local builds both Actors', { timeout: 10 * 60_000 }, async () => {
        const { status, stdout, stderr } = await runCli('build-from-local');
        expect(status, stderr).toBe(0);
        builds = JSON.parse(stdout);
        expect(builds.map((build) => build.actorFullName)).toEqual(ACTORS);
        for (const build of builds) expect(build.buildNumber).toMatch(/^0\.98\.\d+$/);
    });

    it('runs the builds through testActor and reports the results', { timeout: 10 * 60_000 }, async () => {
        expect(builds, 'needs the builds from the previous test').toBeDefined();

        // A consumer's platform test, importing the lib from this checkout
        await linkNodeModules();
        const libPath = path.join(projectRoot, 'index.ts');
        const actorTests = ACTORS.map(
            (actorId) => `
    testActor(${JSON.stringify(actorId)}, 'finishes', async ({ expect, run }) => {
        const result = await run({ input: {} });
        expect(result.status).toBe('SUCCEEDED');
    });`,
        ).join('\n');
        await writeRepoFile(
            'test/platform/dummies.test.ts',
            `import { describe, testActor } from ${JSON.stringify(libPath)};

describe('sandbox dummies', () => {${actorTests}
});
`,
        );

        const tested = await runProcess(
            process.execPath,
            [bundlePath, 'test', '--test-files-glob', 'test/platform/**'],
            {
                cwd: repoDir,
                // Each Actor is tested with the token the config builds it with
                env: cliEnv,
                input: JSON.stringify(builds),
            },
        );
        expect(tested.status, tested.stderr).toBe(0);
        expect(tested.stderr).toContain('https://console.apify.com/view/runs/');

        // Each run used the build piped into `test`, not the Actor's default build.
        const report = JSON.parse(tested.stdout);
        expect(report).toMatchObject({ success: true, summary: { passed: ACTORS.length, failed: 0 } });
        const client = new ApifyClient({ token });
        const runBuildIds = await Promise.all(
            report.tests.map(
                async ({ run }: { run: { runId: string } }) => (await client.run(run.runId).get())?.buildId,
            ),
        );
        expect(runBuildIds.sort()).toEqual(builds.map((build) => build.buildId).sort());

        const { status, stderr } = await runCliWithInput(tested.stdout, 'notify', '--dry-run');
        expect(status, stderr).toBe(0);
        expect(stderr).toContain('Skipping notification');
    });

    it('runs the standby build through testStandbyActor on exactly that build', { timeout: 10 * 60_000 }, async () => {
        const build = builds?.find(({ actorFullName }) => actorFullName === STANDBY_ACTOR);
        expect(build, 'needs the builds from the earlier test').toBeDefined();

        // The sandbox Actor needs standby turned on, which a build doesn't do. Low limits keep its idle runs cheap.
        const client = new ApifyClient({ token });
        const actor = await client.actor(STANDBY_ACTOR).get();
        if (!actor?.actorStandby?.isEnabled) {
            await client.actor(STANDBY_ACTOR).update({
                actorStandby: {
                    isEnabled: true,
                    build: 'latest',
                    memoryMbytes: 256,
                    idleTimeoutSecs: 60,
                    desiredRequestsPerActorRun: 1,
                    maxRequestsPerActorRun: 4,
                },
            });
        }
        // Without X-Actor-Build the platform would serve the Actor's own standby build, which must be another one,
        // or the test can't tell them apart
        const updated = await client.actor(STANDBY_ACTOR).get();
        const standbyBuild = updated?.actorStandby?.build ?? 'latest';
        expect(updated?.taggedBuilds?.[standbyBuild]?.buildNumber ?? standbyBuild).not.toBe(build!.buildNumber);

        await linkNodeModules();
        const libPath = path.join(projectRoot, 'index.ts');
        const input = { hello: 'standby' };
        await writeRepoFile(
            'test/platform/standby.test.ts',
            `import { describe, testStandbyActor } from ${JSON.stringify(libPath)};

describe('sandbox standby dummy', () => {
    testStandbyActor(${JSON.stringify(STANDBY_ACTOR)}, 'answers on the tested build', async ({ expect, callStandby }) => {
        const { status, data, body } = await callStandby({ input: ${JSON.stringify(input)}, path: '/echo?q=1' });
        expect(status, body).toBe(200);
        expect(data).toEqual({
            buildId: ${JSON.stringify(build!.buildId)},
            buildNumber: ${JSON.stringify(build!.buildNumber)},
            method: 'POST',
            path: '/echo?q=1',
            contentType: 'application/json',
            body: ${JSON.stringify(JSON.stringify(input))},
        });
    });
});
`,
        );

        const tested = await runProcess(
            process.execPath,
            [bundlePath, 'test', '--test-files-glob', 'test/platform/standby.test.ts'],
            { cwd: repoDir, env: cliEnv, input: JSON.stringify(builds) },
        );
        expect(tested.status, tested.stderr).toBe(0);
        // Standby tests start no run of their own, so the report links none
        expect(JSON.parse(tested.stdout)).toMatchObject({
            success: true,
            summary: { passed: 1, failed: 0 },
            tests: [{ name: `sandbox standby dummy ${STANDBY_ACTOR}: answers on the tested build`, run: null }],
        });
    });

    // Last, so builds from earlier runs of this suite don't pile up in the sandbox.
    it('delete-old-builds keeps the default builds', async () => {
        const { status, stderr } = await runCli('delete-old-builds');
        expect(status, stderr).toBe(0);
        for (const actorFullName of ACTORS) {
            expect(stderr).toContain(`[DELETE OLD BUILDS][${actorFullName}]: Skipping default build`);
        }
    });
});
