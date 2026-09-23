import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_FILE_NAME, loadActorConfig, readConfigFile } from '../../../../../bin/utils/config/load-config.js';
import type { ResolvedActorConfig } from '../../../../../bin/utils/config/structures/base.js';

let repoDir: string;
let originalCwd: string;

beforeEach(async () => {
    originalCwd = process.cwd();
    // `realpath` because macOS hands out a symlinked temp dir, while `process.cwd()` reports the target.
    repoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'apify-test-tools-config-')));
    process.chdir(repoDir);
});

afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(repoDir, { recursive: true, force: true });
});

const emptyActorSelection = { actors: [], ignore: [] };

const validConfig = (actors: object[]) => JSON.stringify({ actors });
const actorJson = (fields: Record<string, unknown> = {}) => JSON.stringify(fields);

const writeFiles = async (files: Record<string, string>) =>
    Promise.all(
        Object.entries(files).map(async ([filePath, contents]) => {
            const absPath = path.join(repoDir, filePath);
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            await fs.writeFile(absPath, contents);
        }),
    );

describe('loadActorConfig', () => {
    const entry = (fields: Partial<ResolvedActorConfig> = {}): ResolvedActorConfig => ({
        folder: 'actors/shopify',
        actorFullName: 'myteam/shopify',
        tokenEnvVar: 'APIFY_TOKEN',
        overrideActorContext: undefined,
        ...fields,
    });

    const writeActorJson = async (fields: Record<string, unknown> = {}) =>
        writeFiles({ 'actors/shopify/.actor/actor.json': actorJson(fields) });

    it('resolves data coming from actor.json', async () => {
        await writeActorJson({ dockerContextDir: '..' });

        expect(loadActorConfig(entry())).toEqual({
            actorFullName: 'myteam/shopify',
            folder: 'actors/shopify',
            tokenEnvVar: 'APIFY_TOKEN',
            dockerContextDir: 'actors/shopify',
            contextPaths: ['actors/shopify'],
        });
    });

    it('defaults dockerContextDir to the actor folder when actor.json does not set it', async () => {
        await writeActorJson();

        expect(loadActorConfig(entry()).dockerContextDir).toBe('actors/shopify');
    });

    it('resolves dockerContextDir relative to the .actor/ folder, not the actor folder', async () => {
        await writeActorJson({ dockerContextDir: '../../..' });

        expect(loadActorConfig(entry()).dockerContextDir).toBe('');
    });

    it('throws when dockerContextDir resolves outside the repository root', async () => {
        await writeActorJson({ dockerContextDir: '../../../..' });

        expect(() => loadActorConfig(entry())).toThrow(/resolves outside the repository root/);
    });

    it('throws when actor.json is missing', () => {
        expect(() => loadActorConfig(entry())).toThrow('Cannot read');
    });

    it('resolves contextPaths from overrideActorContext', async () => {
        await writeActorJson({ dockerContextDir: '../../..' });

        expect(loadActorConfig(entry({ overrideActorContext: ['actors/shopify', 'packages'] })).contextPaths).toEqual([
            'actors/shopify',
            'packages',
        ]);
    });

    it('adds the actor own folder automatically when overrideActorContext does not cover it', async () => {
        await writeActorJson();

        expect(loadActorConfig(entry({ overrideActorContext: ['code', 'shared'] })).contextPaths).toEqual([
            'code',
            'shared',
            'actors/shopify',
        ]);
    });

    it('allows overrideActorContext with disjoint sibling paths that all reach the actor folder via one entry', async () => {
        await writeActorJson();

        expect(
            loadActorConfig(entry({ overrideActorContext: ['actors/shopify', 'code', 'shared'] })).contextPaths,
        ).toEqual(['actors/shopify', 'code', 'shared']);
    });

    it('throws when overrideActorContext entries overlap (one is a prefix of another)', async () => {
        await writeActorJson();

        expect(() => loadActorConfig(entry({ overrideActorContext: ['actors/shopify', 'actors'] }))).toThrow(/overlap/);
    });

    it('throws when overrideActorContext contains the repo root alongside another entry', async () => {
        await writeActorJson();

        expect(() => loadActorConfig(entry({ overrideActorContext: ['', 'actors/shopify'] }))).toThrow(/overlap/);
    });
});

describe('readConfigFile', () => {
    // Golden output massaging the whole config reading process
    it("carries the parser's normalization through to ActorConfig[]", async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: '.', actorFullName: 'apify/root', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
                {
                    folder: 'actors/shopify/',
                    actorFullName: 'myteam/shopify',
                    tokenEnvVar: 'APIFY_TOKEN',
                    overrideActorContext: ['actors/shopify/', 'packages/'],
                },
            ]),
            '.actor/actor.json': actorJson({}),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        expect(await readConfigFile(emptyActorSelection)).toEqual([
            {
                actorFullName: 'apify/root',
                folder: '',
                tokenEnvVar: 'APIFY_TOKEN_APIFY',
                dockerContextDir: '',
                contextPaths: [''],
            },
            {
                actorFullName: 'myteam/shopify',
                folder: 'actors/shopify',
                tokenEnvVar: 'APIFY_TOKEN',
                dockerContextDir: 'actors/shopify',
                contextPaths: ['actors/shopify', 'packages'],
            },
        ]);
    });

    it('throws when config file is missing', async () => {
        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('not found');
    });

    it('throws when config file contains invalid JSON', async () => {
        await writeFiles({ [CONFIG_FILE_NAME]: '{bad json' });
        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('invalid JSON');
    });

    it('throws when the config file is not a JSON object', async () => {
        await writeFiles({ [CONFIG_FILE_NAME]: JSON.stringify([{ folder: 'actors/shopify' }]) });
        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('"actors" array');
    });

    // The wording of a schema failure belongs to the strategy; this only checks that the failure
    // reaches the caller rather than being swallowed on the way out of readConfigFile.
    it('surfaces a schema failure from the parser', async () => {
        await writeFiles({ [CONFIG_FILE_NAME]: JSON.stringify({ notActors: [] }) });
        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow(/at actors/);
    });
});
