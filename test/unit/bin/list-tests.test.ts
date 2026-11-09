import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectPlatformTestFiles } from '../../../bin/list-tests.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const libraryPath = path.join(projectRoot, 'lib/lib.ts');
const targets = [{ actorFullName: 'owner/actor', actorRawId: 'rawActor' }];
let repoDir: string;

describe('collectPlatformTestFiles', () => {
    beforeEach(async () => {
        vi.stubEnv('TESTER_APIFY_TOKEN', 'caller-token');
        repoDir = await mkdtemp(path.join(os.tmpdir(), 'apify-list-tests-fixture-'));
        await symlink(path.join(projectRoot, 'node_modules'), path.join(repoDir, 'node_modules'), 'dir');
        await writeFile(path.join(repoDir, 'package.json'), '{"type":"module"}');
        await writeFile(
            path.join(repoDir, 'vitest.config.ts'),
            `export default { test: { include: ['*.check.ts'] } };`,
        );
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(repoDir, { recursive: true, force: true });
    });

    it('collects configured platform files by full name and raw ID without running bodies or hooks', async () => {
        const neverRun = `() => { throw new Error('Collection ran a body or hook'); }`;
        const platform = `
            import { beforeAll } from 'vitest';
            import { describe, testActor, testStandbyActor } from ${JSON.stringify(libraryPath)};
            console.log('Consumer output is not JSON');
            beforeAll(${neverRun});
            describe('platform', () => {
                testActor('owner/actor', 'platform', ${neverRun});
                testStandbyActor('owner/actor', 'standby', ${neverRun});
            });
        `;
        await writeFile(path.join(repoDir, 'platform.check.ts'), platform);
        await writeFile(path.join(repoDir, 'raw-id.check.ts'), platform.replaceAll('owner/actor', 'rawActor'));
        await writeFile(
            path.join(repoDir, 'unselected.check.ts'),
            platform.replaceAll('owner/actor', 'owner/unselected'),
        );
        await writeFile(
            path.join(repoDir, 'ordinary.check.ts'),
            `import { test } from 'vitest'; test('ordinary', ${neverRun});`,
        );
        vi.stubEnv('ACTOR_BUILDS', 'caller-selection');
        vi.stubEnv('RUN_PLATFORM_TESTS', '1');
        vi.stubEnv('RUN_ALL_PLATFORM_TESTS', '1');
        expect(await collectPlatformTestFiles({ targets, cwd: repoDir })).toEqual(
            new Set(['platform.check.ts', 'raw-id.check.ts']),
        );
        expect(process.env.TESTER_APIFY_TOKEN).toBe('caller-token');
        expect(process.env.ACTOR_BUILDS).toBe('caller-selection');
        expect(process.env.RUN_ALL_PLATFORM_TESTS).toBe('1');
    });

    it('returns an empty set for a repository with no tests', async () => {
        expect(await collectPlatformTestFiles({ targets: [], cwd: repoDir })).toEqual(new Set());
    });

    it('propagates collection errors', async () => {
        await writeFile(path.join(repoDir, 'vitest.config.ts'), `throw new Error('broken config');`);
        await expect(collectPlatformTestFiles({ targets, cwd: repoDir })).rejects.toThrow();
    });

    it('requires a token instead of silently finding no platform files', async () => {
        vi.stubEnv('TESTER_APIFY_TOKEN', '');
        await expect(collectPlatformTestFiles({ targets, cwd: repoDir })).rejects.toThrow(
            'TESTER_APIFY_TOKEN is not set',
        );
    });
});
