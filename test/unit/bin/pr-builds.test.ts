import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { planPrBuilds, readStoredBuilds } from '../../../bin/pr-builds.js';

const NOW = Date.UTC(2026, 10, 8);
const DAY_SECONDS = 24 * 60 * 60;
const storedBuild = (actorFullName: string, daysAgo = 1) => ({
    actorFullName,
    buildId: `build-${actorFullName}`,
    actorRawId: `raw-${actorFullName}`,
    buildNumber: '0.99.7',
    builtAt: NOW / 1000 - daysAgo * DAY_SECONDS,
});

const plan = (
    functional: string[],
    testChanged: { actorFullName: string; needsBranchBuild: boolean }[],
    storedBuilds = [storedBuild('owner/a')],
) =>
    planPrBuilds({
        affected: {
            functionallyChangedActors: functional.map((actorFullName) => ({ actorFullName })),
            testChangedActors: testChanged,
        },
        storedBuilds,
        now: NOW,
    });

describe('planPrBuilds', () => {
    it('builds every Actor with a functional change, also when its tests changed or it has a stored build', () => {
        expect(plan(['owner/a', 'owner/b'], [{ actorFullName: 'owner/a', needsBranchBuild: true }])).toStrictEqual({
            version: 1,
            build: { actors: [{ actorFullName: 'owner/a' }, { actorFullName: 'owner/b' }] },
            existingBuilds: [],
        });
    });

    it('tests an Actor with only test changes and the code of base on its default build', () => {
        expect(plan([], [{ actorFullName: 'owner/b', needsBranchBuild: false }])).toStrictEqual({
            version: 1,
            build: { actors: [] },
            existingBuilds: [{ actorFullName: 'owner/b' }],
        });
    });

    it('tests an Actor with only test changes and changed code on the build an earlier run stored', () => {
        expect(plan([], [{ actorFullName: 'owner/a', needsBranchBuild: true }])).toStrictEqual({
            version: 1,
            build: { actors: [] },
            existingBuilds: [
                {
                    actorFullName: 'owner/a',
                    buildId: 'build-owner/a',
                    actorRawId: 'raw-owner/a',
                    buildNumber: '0.99.7',
                },
            ],
        });
    });

    it('builds an Actor with only test changes and changed code when no build is stored', () => {
        expect(plan([], [{ actorFullName: 'owner/b', needsBranchBuild: true }])).toStrictEqual({
            version: 1,
            build: { actors: [{ actorFullName: 'owner/b' }] },
            existingBuilds: [],
        });
    });

    it('builds again when the stored build is old enough for delete-old-builds to have deleted it', () => {
        const testChanged = [{ actorFullName: 'owner/a', needsBranchBuild: true }];
        expect(plan([], testChanged, [storedBuild('owner/a', 24)]).existingBuilds).toHaveLength(1);
        expect(plan([], testChanged, [storedBuild('owner/a', 26)]).build.actors).toStrictEqual([
            { actorFullName: 'owner/a' },
        ]);
    });
});

describe('readStoredBuilds', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'apify-pr-builds-'));
    });

    afterAll(async () => {
        if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('reads the stored builds', async () => {
        const file = path.join(dir, 'pr-builds.json');
        await writeFile(file, JSON.stringify([storedBuild('owner/a')]));
        expect(await readStoredBuilds(file)).toStrictEqual([storedBuild('owner/a')]);
    });

    it('has none without a file, so the Actors are built again', async () => {
        expect(await readStoredBuilds(undefined)).toStrictEqual([]);
        expect(await readStoredBuilds(path.join(dir, 'missing.json'))).toStrictEqual([]);
    });

    it('has none when the file is not valid, instead of failing the run', async () => {
        const file = path.join(dir, 'broken.json');
        await writeFile(file, '[{"actorFullName": "owner/a"}]');
        expect(await readStoredBuilds(file)).toStrictEqual([]);
    });
});
