import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFakeApifyApi } from '../../helpers/fake-apify-api.js';
import { compileCli } from './compiled-cli.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

let cliPath: string;
let cleanup: (() => Promise<void>) | undefined;
let repoDir: string;
let fakeApi: Awaited<ReturnType<typeof startFakeApifyApi>> | undefined;

// Only what node needs, so the outer vitest's own variables don't reach the inner one. The fixture's tests never call
// Apify, so any token does.
// `test` looks the Actors' raw IDs up in a fake API, see beforeAll.
const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: os.tmpdir(),
    APIFY_TOKEN_OWNER: 'fake-token',
};

const CONFIG = JSON.stringify({
    actors: [
        { folder: 'actors/a', actorFullName: 'owner/a', tokenEnvVar: 'APIFY_TOKEN_OWNER' },
        { folder: 'actors/p', actorFullName: 'partner/p', tokenEnvVar: 'APIFY_TOKEN_PARTNER' },
    ],
});

const run = (args: string[], input = '', cwd = repoDir, runEnv: NodeJS.ProcessEnv = env) =>
    spawnSync(cliPath, args, { cwd, encoding: 'utf8', input, env: runEnv, stdio: ['pipe', 'pipe', 'pipe'] });

// A test file for the repositories set up inside a test, so they have something to match --test-files-glob
const PASSING_TEST = `import { test } from 'vitest';\n\ntest('owner/a: works', () => {});\n`;

// As `build` prints it. Its stale raw ID shows that `test` ignores it and looks the raw ID up itself.
const build = { buildId: 'b1', actorRawId: 'raw1', buildNumber: '0.99.1', actorFullName: 'owner/a' };
const OWNER_A_RAW_ID = 'rawIdOfOwnerA0000';

// A consumer repository with the vitest it installed: one passing test that started a run, one failing
describe('test CLI', () => {
    beforeAll(async () => {
        ({ cliPath, cleanup } = await compileCli());
        fakeApi = await startFakeApifyApi([
            { id: 'rawIdOfOwnerA0000', username: 'owner', name: 'a' },
            { id: 'rawIdOfPartnerP00', username: 'partner', name: 'p' },
        ]);
        env.APIFY_API_BASE_URL = fakeApi.url;
        repoDir = await mkdtemp(path.join(os.tmpdir(), 'apify-test-cli-'));
        await symlink(path.join(projectRoot, 'node_modules'), path.join(repoDir, 'node_modules'), 'dir');
        await mkdir(path.join(repoDir, 'test/platform'), { recursive: true });
        await mkdir(path.join(repoDir, 'actors/a'), { recursive: true });
        await mkdir(path.join(repoDir, 'actors/p'), { recursive: true });
        // Platform tests on the lib from this checkout, kept out of test/platform so the counts above stay the same.
        // None of them reaches the API.
        await mkdir(path.join(repoDir, 'test/lib'), { recursive: true });
        await writeFile(
            path.join(repoDir, 'test/lib/tokens.test.ts'),
            `import { describe, testActor } from ${JSON.stringify(path.join(projectRoot, 'index.ts'))};

describe('tokens', () => {
    for (const actorId of ['owner/a', 'rawIdOfOwnerA0000']) {
        testActor(actorId, 'gets the client of its token', async ({ expect, apifyClient }) => {
            expect(apifyClient.token).toBe('fake-token');
        }, { retry: 0 });
    }
    testActor('stranger/x', 'has no token', async ({ expect, apifyClient }) => {
        expect(apifyClient.token).toBe('fallback-token');
    }, { retry: 0 });
    testActor('partner/p', 'has its token unset', async ({ expect, apifyClient }) => {
        expect(apifyClient.token).toBe('fallback-token');
    }, { retry: 0 });
});
`,
        );
        // Tests that name their Actor by full name, by raw ID, and by neither
        await mkdir(path.join(repoDir, 'test/ids'), { recursive: true });
        await writeFile(
            path.join(repoDir, 'test/ids/ids.test.ts'),
            `import { describe, testActor } from ${JSON.stringify(path.join(projectRoot, 'index.ts'))};

describe('ids', () => {
    for (const actorId of ['owner/a', 'rawIdOfOwnerA0000', 'not an id']) {
        testActor(actorId, 'is named', async () => {}, { retry: 0 });
    }
});
`,
        );
        await writeFile(path.join(repoDir, 'apify-test-tools.config.json'), CONFIG);
        await writeFile(
            path.join(repoDir, 'test/platform/a.test.ts'),
            `import { expect, test } from 'vitest';

test('owner/a: works', ({ task }) => {
    console.log('ENV', process.env.ACTOR_BUILDS ?? '-');
    task.meta = { runId: 'run1', runLink: 'https://console.apify.com/view/runs/run1', actorId: 'owner/a' } as never;
});

test('owner/a: fails', () => {
    expect(1).toBe(2);
});
`,
        );

        // Outside test/platform, so the tests that run test/platform don't see them
        // Lib versions before 0.10.0 run their describe only with RUN_PLATFORM_TESTS set
        await mkdir(path.join(repoDir, 'test/old-lib'), { recursive: true });
        await writeFile(
            path.join(repoDir, 'test/old-lib/old.test.ts'),
            `import { describe, test } from 'vitest';\n\n` +
                `describe.runIf(!!process.env.RUN_PLATFORM_TESTS)('old lib', () => {\n` +
                `    test('owner/a: runs', () => {});\n` +
                `});\n`,
        );
        await mkdir(path.join(repoDir, 'test/skipped'), { recursive: true });
        await writeFile(
            path.join(repoDir, 'test/skipped/skipped.test.ts'),
            `import { test } from 'vitest';\n\ntest.skip('owner/a: skipped', () => {});\n`,
        );

        for (const folder of ['with-pr', 'without-pr']) {
            await mkdir(path.join(repoDir, 'test/glob', folder), { recursive: true });
            await writeFile(
                path.join(repoDir, 'test/glob', folder, `${folder}.test.ts`),
                `import { test } from 'vitest';\n\ntest('owner/a: ${folder}', () => {});\n`,
            );
        }
    });

    afterAll(async () => {
        await cleanup?.();
        await fakeApi?.close();
        if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    it('tests the builds on stdin, printing the report on stdout and the vitest output on stderr', () => {
        const result = run(['test'], JSON.stringify([build]));
        expect(result.status).toBe(1);
        // Passed on to the lib as ACTOR_BUILDS, the fields in the order test reads them, with the env var of the token
        // the config names for the Actor's tests
        // The raw ID is the one test looked up. Also under the names lib versions before 0.9.0 read.
        const { actorFullName, buildId, buildNumber } = build;
        const actorBuild = {
            actorFullName,
            buildId,
            buildNumber,
            testTokenEnvVar: 'APIFY_TOKEN_OWNER',
            actorRawId: OWNER_A_RAW_ID,
            actorName: actorFullName,
            actorId: OWNER_A_RAW_ID,
        };
        expect(result.stderr).toContain(`ENV ${JSON.stringify([actorBuild])}`);
        expect(result.stderr).toContain('Testing 1 Actor(s): owner/a (0.99.1, APIFY_TOKEN_OWNER)');
        expect(result.stderr).toContain('1) owner/a: works ... https://console.apify.com/view/runs/run1');
        // Vitest's own output still comes through, without the note about the temporary JSON report
        expect(result.stderr).toContain('Test Files');
        expect(result.stderr).not.toContain('JSON report written to');
        expect(JSON.parse(result.stdout)).toMatchObject({
            kind: 'test-report',
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

    it('tests an Actor without a build on its default build', () => {
        // As get-actor-configs prints it
        const actorConfig = { actorFullName: 'owner/a', folder: 'actors/a', tokenEnvVar: 'APIFY_TOKEN_OWNER' };
        const result = run(['test'], JSON.stringify([actorConfig]));
        expect(result.status).toBe(1);
        // Only the fields the lib reads reach it
        expect(result.stderr).toContain(
            `ENV [{"actorFullName":"owner/a","testTokenEnvVar":"APIFY_TOKEN_OWNER","actorRawId":"${OWNER_A_RAW_ID}","actorName":"owner/a","actorId":"${OWNER_A_RAW_ID}"}]`,
        );
        expect(result.stderr).toContain('Testing 1 Actor(s): owner/a (default build, APIFY_TOKEN_OWNER)');
        expect(JSON.parse(result.stdout)).toMatchObject({ success: false, summary: { passed: 1, failed: 1 } });
    });

    it('passes vitest a folder whose files all match as one filter, and adds the reporters it is given', () => {
        const result = run(
            ['--log-level', 'debug', 'test', '--reporter', 'dot', '--reporter', 'verbose'],
            JSON.stringify([build]),
        );
        // The default glob test/platform/** matches every file in test/platform, so vitest gets just that folder
        expect(result.stderr).toMatch(
            /Running vitest: \S+ run \S+\/test\/platform\/ --reporter=default --reporter=json --reporter=dot --reporter=verbose /,
        );
        expect(JSON.parse(result.stdout)).toMatchObject({ summary: { passed: 1, failed: 1 } });
    });

    it('runs only the test files that --test-files-glob matches from the repo root', () => {
        const result = run(['test', '--test-files-glob', 'test/glob/{with-pr,other}/**'], JSON.stringify([build]));
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain('Running the 1 file(s) that match --test-files-glob');
        expect(JSON.parse(result.stdout)).toMatchObject({
            success: true,
            summary: { total: 1, passed: 1 },
            tests: [{ name: 'owner/a: with-pr', file: 'test/glob/with-pr/with-pr.test.ts' }],
        });
    });

    it('fails when --test-files-glob matches no file instead of running every test', () => {
        // Relative to test/platform, the way the workflows took it before
        const result = run(['test', '--test-files-glob', 'hourly'], JSON.stringify([build]));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('No files match --test-files-glob "hourly"');
        expect(result.stdout).toBe('');
    });

    it('runs the describe blocks of lib versions before 0.10.0, which need RUN_PLATFORM_TESTS', () => {
        const result = run(['test', '--test-files-glob', 'test/old-lib/**'], JSON.stringify([build]));
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ summary: { total: 1, passed: 1, skipped: 0 } });
    });

    it('fails when no test ran although Actors were given, instead of passing having tested nothing', () => {
        const result = run(['test', '--test-files-glob', 'test/skipped/**'], JSON.stringify([build]));
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            success: false,
            summary: { total: 1, skipped: 1 },
            errors: [expect.stringContaining('No test ran, although 1 Actor(s) were given')],
        });
    });

    it('warns about a given Actor none of whose tests ran, and passes on the tests of the others', () => {
        const other = { ...build, actorFullName: 'owner/other', buildId: 'b2' };
        const result = run(['test', '--test-files-glob', 'test/glob/with-pr/**'], JSON.stringify([build, other]));
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain('[owner/other]: None of its tests ran');
        expect(result.stderr).not.toContain('[owner/a]: None of its tests ran');
    });

    it('rejects test paths given the old way, as arguments, instead of running every test', () => {
        const result = run(['test', 'test/platform/core'], JSON.stringify([build]));
        expect(result.status).toBe(1);
        // The help that comes with it shows --test-files-glob
        expect(result.stderr).toContain('Unknown command: test/platform/core');
        expect(result.stderr).toContain('--test-files-glob');
        expect(result.stdout).toBe('');
    });

    it('runs the tests without a token, warning that the tests of the Actors it is missing for will fail', () => {
        const result = run(['test'], JSON.stringify([build, { ...build, actorFullName: 'stranger/x' }]), repoDir, {
            ...env,
            APIFY_TOKEN_OWNER: '',
        });
        expect(result.stderr).toContain('APIFY_TOKEN_OWNER is not set, so the tests of owner/a will fail.');
        expect(result.stderr).toContain(
            'Actor stranger/x is not in apify-test-tools.config.json, so its tests will fail.',
        );
        expect(result.stderr).toContain(
            'Testing 2 Actor(s): owner/a (0.99.1, APIFY_TOKEN_OWNER), stranger/x (0.99.1, no own token)',
        );
    });

    it('warns that the tests of the Actors without their own token run with TESTER_APIFY_TOKEN when it is set', () => {
        const result = run(['test'], JSON.stringify([build, { ...build, actorFullName: 'stranger/x' }]), repoDir, {
            ...env,
            APIFY_TOKEN_OWNER: '',
            TESTER_APIFY_TOKEN: 'fallback-token',
        });
        expect(result.stderr).toContain(
            'APIFY_TOKEN_OWNER is not set, so the tests of owner/a run with TESTER_APIFY_TOKEN.',
        );
        expect(result.stderr).toContain(
            'Actor stranger/x is not in apify-test-tools.config.json, so its tests run with TESTER_APIFY_TOKEN.',
        );
    });

    it("fails only the tests of the Actors without a token, the lib runs the others with their Actor's token", () => {
        const targets = [build, { actorFullName: 'stranger/x' }, { actorFullName: 'partner/p' }];
        const result = run(['test', '--test-files-glob', 'test/lib/**'], JSON.stringify(targets));
        expect(result.status).toBe(1);
        const report = JSON.parse(result.stdout);
        expect(report).toMatchObject({ summary: { total: 4, passed: 2, failed: 2, skipped: 0 } });
        const failures = Object.fromEntries(
            report.tests.map(({ name, failureMessages }: { name: string; failureMessages: string[] }) => [
                name,
                failureMessages.join('\n'),
            ]),
        );
        expect(failures['tokens owner/a: gets the client of its token']).toBe('');
        expect(failures['tokens rawIdOfOwnerA0000: gets the client of its token']).toBe('');
        expect(failures['tokens stranger/x: has no token']).toContain(
            'Neither TESTER_APIFY_TOKEN is set. The tests of Actor "stranger/x" need a token.',
        );
        expect(failures['tokens partner/p: has its token unset']).toContain(
            'Neither APIFY_TOKEN_PARTNER nor TESTER_APIFY_TOKEN is set. The tests of Actor "partner/p" need a token.',
        );
    });

    it('runs the tests of the Actors without their own token with TESTER_APIFY_TOKEN, the others with their own', () => {
        const targets = [build, { actorFullName: 'stranger/x' }, { actorFullName: 'partner/p' }];
        const result = run(['test', '--test-files-glob', 'test/lib/**'], JSON.stringify(targets), repoDir, {
            ...env,
            TESTER_APIFY_TOKEN: 'fallback-token',
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ summary: { total: 4, passed: 4, failed: 0 } });
        expect(result.stderr).toContain('APIFY_TOKEN_PARTNER is not set, testing with TESTER_APIFY_TOKEN instead.');
    });

    const failuresOf = (stdout: string): Record<string, string> =>
        Object.fromEntries(
            JSON.parse(stdout).tests.map(({ name, failureMessages }: { name: string; failureMessages: string[] }) => [
                name,
                failureMessages.join('\n'),
            ]),
        );

    it('matches a test to its Actor by full name or raw ID, and fails a test that names it by neither', () => {
        const result = run(['test', '--test-files-glob', 'test/ids/**'], JSON.stringify([build]));
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).summary).toMatchObject({ total: 3, passed: 2, failed: 1 });
        const failures = failuresOf(result.stdout);
        expect(failures['ids owner/a: is named']).toBe('');
        expect(failures['ids rawIdOfOwnerA0000: is named']).toBe('');
        expect(failures['ids not an id: is named']).toContain(
            '"not an id" is neither an Actor\'s full name (owner/name) nor its raw ID (17 letters and digits).',
        );
    });

    it('fails on a lib that runs every test with TESTER_APIFY_TOKEN when it is not set, instead of skipping them all', async () => {
        const oldLibRepo = await mkdtemp(path.join(os.tmpdir(), 'apify-test-cli-old-lib-'));
        try {
            const libDir = path.join(oldLibRepo, 'node_modules/apify-test-tools');
            await mkdir(libDir, { recursive: true });
            await writeFile(
                path.join(libDir, 'package.json'),
                JSON.stringify({ name: 'apify-test-tools', version: '0.10.1' }),
            );
            await symlink(
                path.join(projectRoot, 'node_modules/vitest'),
                path.join(oldLibRepo, 'node_modules/vitest'),
                'dir',
            );
            await mkdir(path.join(oldLibRepo, 'actors/a'), { recursive: true });
            await mkdir(path.join(oldLibRepo, 'test/platform'), { recursive: true });
            await writeFile(path.join(oldLibRepo, 'test/platform/a.test.ts'), PASSING_TEST);
            await writeFile(path.join(oldLibRepo, 'apify-test-tools.config.json'), CONFIG);

            const result = run(['test'], JSON.stringify([build]), oldLibRepo);
            expect(result.status).toBe(1);
            expect(result.stderr).toContain(
                'apify-test-tools 0.10.1 installed in this repository runs every test with TESTER_APIFY_TOKEN',
            );
            expect(result.stderr).toContain('TESTER_APIFY_TOKEN is not set, so it would skip every test');
            expect(result.stdout).toBe('');

            // With the token, the old lib still runs the tests as it always did
            const withToken = run(['test'], JSON.stringify([build]), oldLibRepo, {
                ...env,
                TESTER_APIFY_TOKEN: 'fallback-token',
            });
            expect(withToken.stderr).toContain('Update it to test each Actor with its own token.');
            expect(withToken.stderr).not.toContain('would skip every test');

            await writeFile(
                path.join(libDir, 'package.json'),
                JSON.stringify({
                    name: 'apify-test-tools',
                    version: '0.11.0',
                    apifyTestTools: { actorBuildsVersion: 2 },
                }),
            );
            expect(run(['test'], JSON.stringify([build]), oldLibRepo).stderr).not.toContain('runs every test with');
        } finally {
            await rm(oldLibRepo, { recursive: true, force: true });
        }
    });

    it('fails without the config, which names the token each Actor is tested with', async () => {
        const noConfigRepo = await mkdtemp(path.join(os.tmpdir(), 'apify-test-cli-no-config-'));
        try {
            await symlink(path.join(projectRoot, 'node_modules'), path.join(noConfigRepo, 'node_modules'), 'dir');
            await mkdir(path.join(noConfigRepo, 'test/platform'), { recursive: true });
            await writeFile(path.join(noConfigRepo, 'test/platform/a.test.ts'), PASSING_TEST);
            const result = run(['test'], JSON.stringify([build]), noConfigRepo);
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('Config file "apify-test-tools.config.json" not found');
            expect(result.stdout).toBe('');
        } finally {
            await rm(noConfigRepo, { recursive: true, force: true });
        }
    });

    it('fails on empty stdin instead of testing nothing', () => {
        const result = run(['test']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Expected the Actors to test as JSON on stdin, got nothing');
        expect(result.stdout).toBe('');
    });

    it('fails clearly where vitest is not installed', async () => {
        const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'apify-test-cli-empty-'));
        try {
            const result = run(['test'], '[]', emptyDir);
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
