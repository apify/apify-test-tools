import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { planBranchBuilds, readBranchBuilds } from '../../../bin/branch-builds.js';
import type { ActorConfig, BuildData } from '../../../bin/types.js';

const actor = (actorFullName: string): ActorConfig => ({
    actorFullName,
    folder: `actors/${actorFullName}`,
    tokenEnvVar: 'APIFY_TOKEN',
    dockerContextDir: '',
    contextPaths: [''],
});
const build = (actorFullName: string, buildId: string): BuildData => ({
    buildId,
    actorRawId: `raw-${actorFullName}`,
    buildNumber: '0.99.1',
    actorFullName,
});

const a = actor('owner/a');
const b = actor('owner/b');

describe('planBranchBuilds', () => {
    it('builds the Actors changed since the last validated commit', async () => {
        const result = await planBranchBuilds({
            branchActors: [a],
            actorsChanged: [a],
            previousBuilds: [build('owner/a', 'old-a')],
            buildExists: async () => true,
        });
        expect(result).toStrictEqual({ actorsToBuild: [a], reusedBuilds: [] });
    });

    it('reuses the earlier build of an Actor the branch changed before the last validated commit', async () => {
        const previousB = build('owner/b', 'old-b');
        const result = await planBranchBuilds({
            branchActors: [a, b],
            actorsChanged: [a],
            previousBuilds: [previousB],
            buildExists: async () => true,
        });
        expect(result).toStrictEqual({ actorsToBuild: [a], reusedBuilds: [previousB] });
    });

    it('builds an Actor the branch changed when there is no earlier build of this branch for it', async () => {
        const result = await planBranchBuilds({
            branchActors: [b],
            actorsChanged: [],
            previousBuilds: [],
            buildExists: async () => true,
        });
        expect(result).toStrictEqual({ actorsToBuild: [b], reusedBuilds: [] });
    });

    it('builds an Actor again when its earlier build no longer exists', async () => {
        const buildExists = vi.fn(async () => false);
        const previousB = build('owner/b', 'old-b');
        const result = await planBranchBuilds({
            branchActors: [b],
            actorsChanged: [],
            previousBuilds: [previousB],
            buildExists,
        });
        expect(result).toStrictEqual({ actorsToBuild: [b], reusedBuilds: [] });
        expect(buildExists).toHaveBeenCalledWith(b, previousB);
    });

    it('drops earlier builds of Actors the branch no longer changes', async () => {
        const result = await planBranchBuilds({
            branchActors: [],
            actorsChanged: [],
            previousBuilds: [build('owner/b', 'old-b')],
            buildExists: async () => true,
        });
        expect(result).toStrictEqual({ actorsToBuild: [], reusedBuilds: [] });
    });
});

describe('readBranchBuilds', () => {
    it('returns an empty list when the file does not exist', () => {
        expect(readBranchBuilds(path.join(os.tmpdir(), 'missing-branch-builds.json'))).toStrictEqual([]);
    });

    it('reads the builds from the file', () => {
        const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'branch-builds-')), 'branch_builds.json');
        const builds = [build('owner/a', 'id-a')];
        fs.writeFileSync(filePath, JSON.stringify(builds));
        expect(readBranchBuilds(filePath)).toStrictEqual(builds);
    });
});
