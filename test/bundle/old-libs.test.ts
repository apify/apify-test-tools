import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OLDEST_SUPPORTED_LIB_VERSION } from '../../bin/lib-compat.js';
import { startFakeApifyApi } from '../helpers/fake-apify-api.js';

// The CLI ships separately from the lib, so a repository can run the newest CLI with an old lib. These run the
// committed bundle's `test` in a repository that installed an old lib, the way the PR and scheduled workflows run it,
// and check that the tests of the Actors it is given run. A mismatch in what the two pass each other skips every test,
// and the run still passes. No test here starts an Actor run, so they need no token or network.
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const bundlePath = path.join(projectRoot, '.github/cli/apify-test-tools.mjs');

// The old libs are dev dependencies under npm aliases. The oldest one must be the oldest supported version.
const OLD_LIBS = [
    { alias: 'apify-test-tools-oldest', why: 'the oldest supported version' },
    { alias: 'apify-test-tools-0-9-0', why: 'the last version that needs RUN_PLATFORM_TESTS' },
];

// `test` looks the raw ID up in a fake API, see beforeAll
const build = { actorFullName: 'owner/a', buildId: 'b1', buildNumber: '0.99.1' };
let fakeApi: Awaited<ReturnType<typeof startFakeApifyApi>> | undefined;

beforeAll(async () => {
    fakeApi = await startFakeApifyApi([{ id: 'rawIdOfOwnerA0000', username: 'owner', name: 'a' }]);
});

const testFile = `import { describe, testActor } from 'apify-test-tools';

describe('old lib suite', () => {
    testActor('owner/a', 'by full name', async () => {});
    testActor('rawIdOfOwnerA0000', 'by raw ID', async () => {});
    testActor('owner/other', 'of an Actor not given', async () => {});
});
`;

const repoDirs: string[] = [];

/** A repository whose apify-test-tools is the given alias, and whose vitest is this project's. */
const repoWithLib = async (alias: string) => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), 'apify-old-lib-'));
    repoDirs.push(repoDir);
    await mkdir(path.join(repoDir, 'node_modules'));
    await symlink(path.join(projectRoot, 'node_modules', alias), path.join(repoDir, 'node_modules/apify-test-tools'));
    await symlink(path.join(projectRoot, 'node_modules/vitest'), path.join(repoDir, 'node_modules/vitest'));
    await mkdir(path.join(repoDir, 'test/platform'), { recursive: true });
    await writeFile(path.join(repoDir, 'test/platform/old.test.ts'), testFile);
    // `test` reads each Actor's test token from the config
    await mkdir(path.join(repoDir, 'actors/a'), { recursive: true });
    await writeFile(
        path.join(repoDir, 'apify-test-tools.config.json'),
        JSON.stringify({
            actors: [{ folder: 'actors/a', actorFullName: 'owner/a', tokenEnvVar: 'APIFY_TOKEN_OWNER' }],
        }),
    );
    return repoDir;
};

afterAll(async () => {
    await fakeApi?.close();
    for (const repoDir of repoDirs) await rm(repoDir, { recursive: true, force: true });
});

describe('test with an old lib', () => {
    it('keeps the oldest old lib at the oldest supported version', async () => {
        const { devDependencies } = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
        expect(devDependencies['apify-test-tools-oldest']).toBe(`npm:apify-test-tools@${OLDEST_SUPPORTED_LIB_VERSION}`);
    });

    it.each(OLD_LIBS)('runs the tests of the given Actors with $alias, $why', async ({ alias }) => {
        const repoDir = await repoWithLib(alias);
        const result = spawnSync(process.execPath, [bundlePath, 'test'], {
            cwd: repoDir,
            env: {
                PATH: process.env.PATH ?? '',
                HOME: os.tmpdir(),
                TESTER_APIFY_TOKEN: 'fake-token',
                APIFY_API_BASE_URL: fakeApi!.url,
            },
            input: JSON.stringify([build]),
            encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.summary).toStrictEqual({ total: 3, passed: 2, failed: 0, skipped: 1 });
        expect(
            Object.fromEntries(report.tests.map((test: { name: string; status: string }) => [test.name, test.status])),
        ).toStrictEqual({
            'old lib suite owner/a: by full name': 'passed',
            'old lib suite rawIdOfOwnerA0000: by raw ID': 'passed',
            'old lib suite owner/other: of an Actor not given': 'skipped',
        });
        // Such a lib runs every test with TESTER_APIFY_TOKEN, so it is asked to update, though not for its age
        expect(result.stderr).toContain('Update it to test each Actor with its own token.');
        expect(result.stderr).not.toContain('the oldest version this CLI supports');
    });

    it.each(OLD_LIBS)('refuses $alias without TESTER_APIFY_TOKEN, the only token it reads', async ({ alias }) => {
        const repoDir = await repoWithLib(alias);
        const result = spawnSync(process.execPath, [bundlePath, 'test'], {
            cwd: repoDir,
            env: {
                PATH: process.env.PATH ?? '',
                HOME: os.tmpdir(),
                APIFY_TOKEN_OWNER: 'fake-token',
                APIFY_API_BASE_URL: fakeApi!.url,
            },
            input: JSON.stringify([build]),
            encoding: 'utf8',
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('TESTER_APIFY_TOKEN is not set');
        expect(result.stdout).toBe('');
    });
});
