import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { OLDEST_SUPPORTED_LIB_VERSION } from '../../bin/lib-compat.js';

// The CLI ships separately from the lib, so a repository can run the newest CLI with an old lib. A mismatch in what
// the two pass each other skips every test while the run still passes, so the committed bundle's `test` refuses a lib
// older than the oldest supported version. No test here starts an Actor run, so they need no token or network.
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const bundlePath = path.join(projectRoot, '.github/cli/apify-test-tools.mjs');

const build = { actorFullName: 'owner/a', actorRawId: 'rawIdOfOwnerA0000', buildId: 'b1', buildNumber: '0.99.1' };

const repoDirs: string[] = [];

/** A repository whose installed apify-test-tools reports the given version, and whose vitest is this project's. */
const repoWithLibVersion = async (version: string) => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), 'apify-old-lib-'));
    repoDirs.push(repoDir);
    await mkdir(path.join(repoDir, 'node_modules/apify-test-tools'), { recursive: true });
    await writeFile(path.join(repoDir, 'node_modules/apify-test-tools/package.json'), JSON.stringify({ version }));
    await symlink(path.join(projectRoot, 'node_modules/vitest'), path.join(repoDir, 'node_modules/vitest'));
    await mkdir(path.join(repoDir, 'test/platform'), { recursive: true });
    await writeFile(
        path.join(repoDir, 'test/platform/a.test.ts'),
        `import { test } from 'vitest';\n\ntest('owner/a: runs', () => {});\n`,
    );
    return repoDir;
};

const runTest = (cwd: string) =>
    spawnSync(process.execPath, [bundlePath, 'test'], {
        cwd,
        env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), TESTER_APIFY_TOKEN: 'fake-token' },
        input: JSON.stringify([build]),
        encoding: 'utf8',
    });

afterAll(async () => {
    for (const repoDir of repoDirs) await rm(repoDir, { recursive: true, force: true });
});

describe('test with an old lib', () => {
    it('refuses a lib older than the oldest supported version instead of skipping its tests', async () => {
        const result = runTest(await repoWithLibVersion('0.11.0'));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `apify-test-tools 0.11.0, older than ${OLDEST_SUPPORTED_LIB_VERSION}, the oldest version this CLI supports`,
        );
        expect(result.stdout).toBe('');
    });

    it.each([OLDEST_SUPPORTED_LIB_VERSION, `${OLDEST_SUPPORTED_LIB_VERSION}-beta.3`])(
        'runs the tests with lib %s',
        async (version) => {
            const result = runTest(await repoWithLibVersion(version));
            expect(result.status, result.stderr).toBe(0);
            expect(JSON.parse(result.stdout)).toMatchObject({ success: true, summary: { total: 1, passed: 1 } });
        },
    );
});
