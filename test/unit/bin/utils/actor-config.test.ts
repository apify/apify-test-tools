import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    CONFIG_FILE_NAME,
    denormalizeConfig,
    loadActorConfig,
    parseConfigFile,
    readConfigFile,
} from '../../../../bin/utils/actor-config.js';

// `readConfigFile` resolves every path against the process's working directory, so these tests give it
// a real one: a throwaway repo in a temp dir. Reading actual files rather than a mocked
// `node:fs/promises` is what makes the path handling (the ".actor/" hop, a dockerContextDir escaping
// the repo root) worth asserting on — against a mock those assertions only describe the mock.
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

// Stages 2-4 are callable on their own, which is the point: a differently shaped config file only
// has to reach `denormalizeConfig`'s output to work with everything downstream.
describe('the parse/denormalize/load seam', () => {
    it('parseConfigFile validates the file shape without touching the filesystem', () => {
        const entry = { folder: 'actors/shopify', actorFullName: 'myteam/shopify', tokenEnvVar: 'APIFY_TOKEN' };

        expect(parseConfigFile({ actors: [entry] })).toEqual({ actors: [entry] });
        expect(() => parseConfigFile({ actors: [{ ...entry, folder: 123 }] })).toThrow(/Invalid "folder"/);
    });

    it('denormalizeConfig is where the repo root becomes "" and trailing slashes go', () => {
        const result = denormalizeConfig({
            actors: [
                { folder: '.', actorFullName: 'myteam/root', tokenEnvVar: 'APIFY_TOKEN' },
                {
                    folder: 'actors/shopify/',
                    actorFullName: 'myteam/shopify',
                    tokenEnvVar: 'APIFY_TOKEN',
                    overrideActorContext: ['packages/'],
                },
            ],
        });

        expect(result).toEqual([
            { folder: '', actorFullName: 'myteam/root', tokenEnvVar: 'APIFY_TOKEN', overrideActorContext: undefined },
            {
                folder: 'actors/shopify',
                actorFullName: 'myteam/shopify',
                tokenEnvVar: 'APIFY_TOKEN',
                overrideActorContext: ['packages'],
            },
        ]);
    });

    it('loadActorConfig resolves an entry that never came from a config file', async () => {
        await writeFiles({ 'actors/shopify/.actor/actor.json': actorJson({ dockerContextDir: '..' }) });

        await expect(
            loadActorConfig({ folder: 'actors/shopify', actorFullName: 'myteam/shopify', tokenEnvVar: 'APIFY_TOKEN' }),
        ).resolves.toEqual({
            actorFullName: 'myteam/shopify',
            folder: 'actors/shopify',
            tokenEnvVar: 'APIFY_TOKEN',
            dockerContextDir: 'actors/shopify',
            contextPaths: ['actors/shopify'],
        });
    });
});

describe('readConfigFile', () => {
    it('returns correct ActorConfig[] for a valid config', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                {
                    folder: 'actors/shopify',
                    actorFullName: 'myteam/shopify-scraper',
                    tokenEnvVar: 'APIFY_TOKEN_MYTEAM',
                },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({ dockerContextDir: '../../..' }),
        });

        const result = await readConfigFile(emptyActorSelection);
        expect(result).toEqual([
            {
                actorFullName: 'myteam/shopify-scraper',
                folder: 'actors/shopify',
                tokenEnvVar: 'APIFY_TOKEN_MYTEAM',
                dockerContextDir: '',
                contextPaths: [''],
            },
        ]);
    });

    it('normalizes folder "." to ""', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: '.', actorFullName: 'apify/my-actor', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            '.actor/actor.json': actorJson({}),
        });

        const result = await readConfigFile(emptyActorSelection);
        expect(result[0].folder).toBe('');
    });

    it('defaults dockerContextDir to actor folder when absent from actor.json', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/web-scraper', actorFullName: 'apify/web-scraper', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            'actors/web-scraper/.actor/actor.json': actorJson({}),
        });

        const result = await readConfigFile(emptyActorSelection);
        expect(result[0].dockerContextDir).toBe('actors/web-scraper');
        expect(result[0].contextPaths).toEqual(['actors/web-scraper']);
    });

    it('resolves dockerContextDir relative to .actor/ folder', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/shopify', actorFullName: 'myteam/shopify', tokenEnvVar: 'APIFY_TOKEN' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({ dockerContextDir: '../../..' }),
        });

        const result = await readConfigFile(emptyActorSelection);
        expect(result[0].dockerContextDir).toBe('');
    });

    it('throws when dockerContextDir resolves outside the repository root', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/shopify', actorFullName: 'myteam/shopify', tokenEnvVar: 'APIFY_TOKEN' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({ dockerContextDir: '../../../..' }),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow(/resolves outside the repository root/);
    });

    it('resolves contextPaths from overrideActorContext', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                {
                    folder: 'actors/shopify',
                    actorFullName: 'myteam/shopify',
                    tokenEnvVar: 'APIFY_TOKEN',
                    overrideActorContext: ['actors/shopify', 'packages'],
                },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({ dockerContextDir: '../../..' }),
        });

        const result = await readConfigFile(emptyActorSelection);
        expect(result[0].contextPaths).toEqual(['actors/shopify', 'packages']);
    });

    it('handles multiple actors', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/web-scraper', actorFullName: 'apify/web-scraper', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
                {
                    folder: 'actors/email-sender',
                    actorFullName: 'other-team/email-sender',
                    tokenEnvVar: 'APIFY_TOKEN_OTHER_TEAM',
                },
            ]),
            'actors/web-scraper/.actor/actor.json': actorJson({}),
            'actors/email-sender/.actor/actor.json': actorJson({}),
        });

        const result = await readConfigFile(emptyActorSelection);
        expect(result).toHaveLength(2);
        expect(result[0].actorFullName).toBe('apify/web-scraper');
        expect(result[1].actorFullName).toBe('other-team/email-sender');
    });

    it('throws when config file is missing', async () => {
        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('not found');
    });

    it('throws when config file contains invalid JSON', async () => {
        await writeFiles({ [CONFIG_FILE_NAME]: '{bad json' });
        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('invalid JSON');
    });

    it('throws when actors array is missing', async () => {
        await writeFiles({ [CONFIG_FILE_NAME]: JSON.stringify({ notActors: [] }) });
        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('"actors" array');
    });

    it('throws when the config file is not a JSON object', async () => {
        await writeFiles({ [CONFIG_FILE_NAME]: JSON.stringify([{ folder: 'actors/shopify' }]) });
        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('"actors" array');
    });

    it('throws on duplicate folders', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/shopify', actorFullName: 'apify/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
                { folder: 'actors/shopify', actorFullName: 'other/shopify', tokenEnvVar: 'APIFY_TOKEN_OTHER' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Duplicate folder');
    });

    it('throws on duplicate folders after normalization ("." and "")', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: '.', actorFullName: 'apify/actor-a', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
                { folder: '', actorFullName: 'other/actor-b', tokenEnvVar: 'APIFY_TOKEN_OTHER' },
            ]),
            '.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Duplicate folder');
    });

    it('throws when actor.json is missing', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/shopify', actorFullName: 'apify/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Cannot read');
    });

    it('throws when folder is missing', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([{ actorFullName: 'apify/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' }]),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow(/Invalid "folder"/);
    });

    it('throws when folder is not a string', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 123, actorFullName: 'apify/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow(/Invalid "folder"/);
    });

    it('throws when actorFullName is missing', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([{ folder: 'actors/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' }]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Invalid "actorFullName"');
    });

    it('throws when actorFullName has no slash', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/shopify', actorFullName: 'shopify-scraper', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Invalid "actorFullName"');
    });

    it('throws when actorFullName has empty parts', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/shopify', actorFullName: '/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Invalid "actorFullName"');
    });

    it('throws when tokenEnvVar is missing', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([{ folder: 'actors/shopify', actorFullName: 'apify/shopify' }]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Invalid "tokenEnvVar"');
    });

    it('reports every invalid field at once instead of only the first', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([{ folder: 123, actorFullName: 'shopify', overrideActorContext: 'nope' }]),
        });

        const promise = readConfigFile(emptyActorSelection);
        await expect(promise).rejects.toThrow(/Invalid "folder"/);
        await expect(promise).rejects.toThrow(/Invalid "actorFullName"/);
        await expect(promise).rejects.toThrow(/Invalid "tokenEnvVar"/);
        await expect(promise).rejects.toThrow(/Invalid "overrideActorContext"/);
    });

    it('throws when overrideActorContext is not an array', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                {
                    folder: 'actors/shopify',
                    actorFullName: 'myteam/shopify',
                    tokenEnvVar: 'APIFY_TOKEN',
                    overrideActorContext: 'packages',
                },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Invalid "overrideActorContext"');
    });

    it('throws when overrideActorContext contains non-strings', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                {
                    folder: 'actors/shopify',
                    actorFullName: 'myteam/shopify',
                    tokenEnvVar: 'APIFY_TOKEN',
                    overrideActorContext: [123],
                },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Invalid "overrideActorContext"');
    });

    it('throws when overrideActorContext entries overlap (one is a prefix of another)', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                {
                    folder: 'actors/shopify',
                    actorFullName: 'myteam/shopify',
                    tokenEnvVar: 'APIFY_TOKEN',
                    overrideActorContext: ['actors/shopify', 'actors'],
                },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow(/overlap/);
    });

    it('throws when overrideActorContext contains the repo root alongside another entry', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                {
                    folder: 'actors/shopify',
                    actorFullName: 'myteam/shopify',
                    tokenEnvVar: 'APIFY_TOKEN',
                    overrideActorContext: ['', 'actors/shopify'],
                },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow(/overlap/);
    });

    it('adds the actor own folder automatically when overrideActorContext does not cover it', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                {
                    folder: 'actors/shopify',
                    actorFullName: 'myteam/shopify',
                    tokenEnvVar: 'APIFY_TOKEN',
                    overrideActorContext: ['code', 'shared'],
                },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        const result = await readConfigFile(emptyActorSelection);
        expect(result[0].contextPaths).toEqual(['code', 'shared', 'actors/shopify']);
    });

    it('strips trailing slashes from folder and overrideActorContext entries', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                {
                    folder: 'actors/shopify/',
                    actorFullName: 'myteam/shopify',
                    tokenEnvVar: 'APIFY_TOKEN',
                    overrideActorContext: ['actors/shopify/', 'packages/'],
                },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        const result = await readConfigFile(emptyActorSelection);
        expect(result[0].folder).toBe('actors/shopify');
        expect(result[0].contextPaths).toEqual(['actors/shopify', 'packages']);
    });

    it('allows overrideActorContext with disjoint sibling paths that all reach the actor folder via one entry', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                {
                    folder: 'actors/shopify',
                    actorFullName: 'myteam/shopify',
                    tokenEnvVar: 'APIFY_TOKEN',
                    overrideActorContext: ['actors/shopify', 'code', 'shared'],
                },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        const result = await readConfigFile(emptyActorSelection);
        expect(result[0].contextPaths).toEqual(['actors/shopify', 'code', 'shared']);
    });

    describe('actor selection', () => {
        const twoActors = async () =>
            writeFiles({
                [CONFIG_FILE_NAME]: validConfig([
                    { folder: 'actors/a', actorFullName: 'team/a', tokenEnvVar: 'TOKEN' },
                    { folder: 'actors/b', actorFullName: 'team/b', tokenEnvVar: 'TOKEN' },
                ]),
                'actors/a/.actor/actor.json': actorJson({}),
                'actors/b/.actor/actor.json': actorJson({}),
            });

        const fullNames = (result: { actorFullName: string }[]) => result.map((c) => c.actorFullName);

        it('returns all actors when the selection is empty', async () => {
            await twoActors();
            expect(fullNames(await readConfigFile(emptyActorSelection))).toEqual(['team/a', 'team/b']);
        });

        it('keeps only the selected actors', async () => {
            await twoActors();
            expect(fullNames(await readConfigFile({ actors: ['team/a'], ignore: [] }))).toEqual(['team/a']);
        });

        it('drops ignored actors', async () => {
            await twoActors();
            expect(fullNames(await readConfigFile({ actors: [], ignore: ['team/a'] }))).toEqual(['team/b']);
        });

        it('throws on an unknown actor name', async () => {
            await twoActors();
            await expect(readConfigFile({ actors: ['team/nope'], ignore: [] })).rejects.toThrow(
                'do not exist: team/nope',
            );
        });
    });
});
