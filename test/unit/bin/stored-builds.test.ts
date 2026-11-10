import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readStoredBuilds } from '../../../bin/stored-builds.js';

const storedBuild = { actorFullName: 'owner/a', buildId: 'b1', actorRawId: 'raw-a', buildNumber: '0.99.4' };

describe('readStoredBuilds', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'apify-stored-builds-'));
    });

    afterAll(async () => {
        if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('reads the builds as build prints them, ignoring other fields', async () => {
        const file = path.join(dir, 'pr-builds.json');
        await writeFile(file, JSON.stringify([{ ...storedBuild, builtAt: 1 }]));
        expect(await readStoredBuilds(file)).toStrictEqual([storedBuild]);
    });

    it('skips the default builds that build passes through, which have no buildId', async () => {
        const file = path.join(dir, 'with-default.json');
        await writeFile(file, JSON.stringify([{ actorFullName: 'owner/b' }, storedBuild]));
        expect(await readStoredBuilds(file)).toStrictEqual([storedBuild]);
    });

    it('has none without a file, so the Actors are built again', async () => {
        expect(await readStoredBuilds(undefined)).toStrictEqual([]);
        expect(await readStoredBuilds(path.join(dir, 'missing.json'))).toStrictEqual([]);
    });

    it('has none when the file is not valid, instead of failing the run', async () => {
        const file = path.join(dir, 'broken.json');
        await writeFile(file, '[{"actorFullName": "owner/a", "buildId": "b1"}]');
        expect(await readStoredBuilds(file)).toStrictEqual([]);
        await writeFile(file, '{"builds": []}');
        expect(await readStoredBuilds(file)).toStrictEqual([]);
    });
});
