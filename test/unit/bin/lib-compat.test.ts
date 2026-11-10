import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findInstalledLibVersion, isOlderVersion } from '../../../bin/lib-compat.js';

describe('isOlderVersion', () => {
    it.each([
        ['0.2.3', '0.2.4', true],
        ['0.2.4', '0.2.4', false],
        ['0.10.0', '0.9.0', false],
        ['0.9.12', '0.10.0', true],
        ['1.0.0-beta.1', '0.2.4', false],
    ])('%s is older than %s: %s', (version, than, older) => {
        expect(isOlderVersion(version, than)).toBe(older);
    });
});

describe('findInstalledLibVersion', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'apify-lib-compat-'));
        await mkdir(path.join(dir, 'node_modules/apify-test-tools'), { recursive: true });
        await writeFile(path.join(dir, 'node_modules/apify-test-tools/package.json'), '{"version": "0.8.2"}');
        await mkdir(path.join(dir, 'packages/actor'), { recursive: true });
    });

    afterAll(async () => {
        if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('finds the version Node would resolve, also from a subfolder', async () => {
        expect(await findInstalledLibVersion(dir)).toBe('0.8.2');
        expect(await findInstalledLibVersion(path.join(dir, 'packages/actor'))).toBe('0.8.2');
    });

    it('finds none where the lib is not installed', async () => {
        expect(await findInstalledLibVersion(os.tmpdir())).toBeUndefined();
    });
});
