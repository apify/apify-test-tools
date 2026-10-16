import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { ApifyClient } from 'apify-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// End-to-end run of the shipped CLI bundle against two dummy Actors in an isolated sandbox account:
// dry-run plans read the real Actors, `build-from-local` really builds them, the lib runs them
// through `testActor` on exactly those builds (the ACTOR_BUILDS handoff), `report-tests` reads the
// result, and `delete-old-builds` cleans up. Git builds (`build`/`release` without --dry-run) are
// not covered: the Apify builder would have to clone the fixture repo, which only exists locally.
//
// Runs with `npm run test:e2e`, kept out of `npm test`. Skipped without the token, e.g. on fork PRs.
const TOKEN_ENV_VAR = 'E2E_TEST_APIFY_TOKEN_DBYPODOIHUZABNQTR';
const token = process.env[TOKEN_ENV_VAR];

const ACTORS = ['test-tools-testing-sandbox/dummy-for-testing-1', 'test-tools-testing-sandbox/dummy-for-testing-2'];
// Only used as the source URL in dry-run plans; nothing is cloned from it.
const REPO_URL = 'https://github.com/apify/apify-test-tools-e2e-fixture';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const bundlePath = path.join(projectRoot, '.github/cli/apify-test-tools.mjs');
const vitestPath = path.join(projectRoot, 'node_modules/vitest/vitest.mjs');

// Proxy and CA settings pass through so the API is reachable behind a proxy; no other variable does.
const networkEnv = Object.fromEntries(
    ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS']
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]!]),
);
const baseEnv = { PATH: process.env.PATH ?? '', HOME: os.tmpdir() };
// The CLI gets only the sandbox token, under the name the fixture config points at.
const cliEnv = { ...baseEnv, ...networkEnv, [TOKEN_ENV_VAR]: token ?? '' };
const gitEnv = {
    ...baseEnv,
    GIT_AUTHOR_NAME: 'Tester',
    GIT_AUTHOR_EMAIL: 'tester@example.com',
    GIT_COMMITTER_NAME: 'Tester',
    GIT_COMMITTER_EMAIL: 'tester@example.com',
};

let repoDir: string;
let baseSha: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, env: gitEnv, encoding: 'utf8' }).trim();

const writeRepoFile = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(repoDir, file)), { recursive: true });
    await writeFile(path.join(repoDir, file), content);
};

// Spawned processes are blocking, so vitest's own timeouts can't stop one that hangs. apify-client
// retries an unreachable API for minutes, so a hang is killed here and fails with a clear error.
const PROCESS_TIMEOUT_MS = 8 * 60_000;

const runCli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [bundlePath, ...args], {
        cwd: repoDir,
        env: cliEnv,
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT_MS,
    });
    const error = result.error ? `\n${result.error.message}` : '';
    return { status: result.status, stdout: result.stdout, stderr: result.stderr + error };
};

interface ActorBuild {
    buildId: string;
    actorRawId: string;
    buildNumber: string;
    actorFullName: string;
}

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
            await writeRepoFile(
                `${folder}/.actor/actor.json`,
                JSON.stringify({
                    actorSpecification: 1,
                    name: actorFullName.split('/')[1],
                    version: '0.0',
                    dockerfile: '../Dockerfile',
                }),
            );
            await writeRepoFile(
                `${folder}/Dockerfile`,
                'FROM apify/actor-node:22\nCOPY . ./\nCMD ["node", "main.js"]\n',
            );
            await writeRepoFile(`${folder}/main.js`, `console.log('dummy ${i + 1}');\n`);
            actors.push({ folder, actorFullName, tokenEnvVar: TOKEN_ENV_VAR });
        }
        await writeRepoFile('apify-test-tools.config.json', JSON.stringify({ actors }));
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

    it('build --dry-run plans a test build of the changed Actor only', () => {
        const { status, stdout, stderr } = runCli(
            'build',
            '--source-branch',
            'feature',
            '--target-branch',
            'main',
            '--repo-url',
            REPO_URL,
            '--dry-run',
        );
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout)).toEqual({
            dryRun: true,
            builds: [
                {
                    actorFullName: ACTORS[0],
                    versionNumber: '0.99',
                    gitRepoUrl: `${REPO_URL}#feature:actors/dummy-1`,
                    useDockerCache: false,
                },
            ],
        });
    });

    it('release --dry-run plans a build of the default version and tag', () => {
        const { status, stderr } = runCli('release', '--base-commit', baseSha, '--repo-url', REPO_URL, '--dry-run');
        expect(status, stderr).toBe(0);
        expect(stderr).toContain(
            `[DRY RUN] Would build:\n  ${ACTORS[0]} (0.0) from ${REPO_URL}#feature:actors/dummy-1`,
        );
        expect(stderr).toContain('Skipping slack notification');
    });

    it('build-from-local --dry-run plans both Actors from the working tree', () => {
        const { status, stdout, stderr } = runCli('build-from-local', '--dry-run');
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({
            dryRun: true,
            builds: ACTORS.map((actorFullName) => ({ actorFullName, versionNumber: '0.98', fileCount: 3 })),
        });
    });

    it('build-from-local builds both Actors', { timeout: 10 * 60_000 }, () => {
        const { status, stdout, stderr } = runCli('build-from-local');
        expect(status, stderr).toBe(0);
        builds = JSON.parse(stdout);
        expect(builds.map((build) => build.actorFullName)).toEqual(ACTORS);
        for (const build of builds) expect(build.buildNumber).toMatch(/^0\.98\.\d+$/);
    });

    it('runs the builds through testActor and reports the results', { timeout: 10 * 60_000 }, async () => {
        expect(builds, 'needs the builds from the previous test').toBeDefined();

        // A consumer's platform test, importing the lib from this checkout. The symlink lets it
        // resolve vitest and the lib's dependencies the way an installed package would.
        await symlink(path.join(projectRoot, 'node_modules'), path.join(repoDir, 'node_modules'), 'dir');
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

        const vitest = spawnSync(
            process.execPath,
            [vitestPath, 'run', 'test/platform', '--reporter=json', '--outputFile=./test-output.json'],
            {
                cwd: repoDir,
                encoding: 'utf8',
                timeout: PROCESS_TIMEOUT_MS,
                env: { ...cliEnv, TESTER_APIFY_TOKEN: token, ACTOR_BUILDS: JSON.stringify(builds) },
            },
        );
        expect(
            vitest.status,
            `${vitest.stdout}\n${vitest.stderr}${vitest.error ? `\n${vitest.error.message}` : ''}`,
        ).toBe(0);

        // Each run used the build from ACTOR_BUILDS, not the Actor's default build.
        const report = JSON.parse(await readFile(path.join(repoDir, 'test-output.json'), 'utf8'));
        const assertions = report.testResults.flatMap(
            (file: { assertionResults: { meta: { runId: string } }[] }) => file.assertionResults,
        );
        expect(assertions).toHaveLength(ACTORS.length);
        const client = new ApifyClient({ token });
        const runBuildIds = await Promise.all(
            assertions.map(
                async ({ meta }: { meta: { runId: string } }) => (await client.run(meta.runId).get())?.buildId,
            ),
        );
        expect(runBuildIds.sort()).toEqual(builds.map((build) => build.buildId).sort());

        const { status, stderr } = runCli('report-tests', '--report-file', 'test-output.json', '--dry-run');
        expect(status, stderr).toBe(0);
        expect(stderr).toContain(`PASSED: ${ACTORS.length}, FAILED: 0`);
        expect(stderr).toContain('https://console.apify.com/view/runs/');
    });

    // Last, so builds from earlier runs of this suite don't pile up in the sandbox.
    it('delete-old-builds keeps the default builds', () => {
        const { status, stderr } = runCli('delete-old-builds');
        expect(status, stderr).toBe(0);
        for (const actorFullName of ACTORS) {
            expect(stderr).toContain(`[DELETE OLD BUILDS][${actorFullName}]: Skipping default build`);
        }
    });
});
