import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_FILE_NAME, loadActorConfig, readConfigFile } from '../../../../../bin/utils/config/load-config.js';

// `readConfigFile` resolves every path against the process's working directory, so these tests give it
// a real one: a throwaway repo in a temp dir. Reading actual files rather than a mocked
// `node:fs/promises` is what makes the path handling (the ".actor/" hop, a dockerContextDir escaping
// the repo root) worth asserting on — against a mock those assertions only describe the mock.
//
// The shape of the config file itself is the parser's business; see ./parser.test.ts and
// ./structures/legacy.test.ts.
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
    it('resolves data coming from actor.json', async () => {
        await writeFiles({ 'actors/shopify/.actor/actor.json': actorJson({ dockerContextDir: '..' }) });

        expect(
            loadActorConfig({ folder: 'actors/shopify', actorFullName: 'myteam/shopify', tokenEnvVar: 'APIFY_TOKEN' }),
        ).toEqual({
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

    it('throws when two folders declare the same actor', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/one', actorFullName: 'apify/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
                { folder: 'actors/two', actorFullName: 'apify/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            'actors/one/.actor/actor.json': actorJson({}),
            'actors/two/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Duplicate actor');
    });

    it('throws when actor.json is missing', async () => {
        await writeFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/shopify', actorFullName: 'apify/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Cannot read');
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
                    { folder: 'actors/a', actorFullName: 'team/actor-a', tokenEnvVar: 'TOKEN' },
                    { folder: 'actors/b', actorFullName: 'team/actor-b', tokenEnvVar: 'TOKEN' },
                ]),
                'actors/a/.actor/actor.json': actorJson({}),
                'actors/b/.actor/actor.json': actorJson({}),
            });

        const fullNames = (result: { actorFullName: string }[]) => result.map((c) => c.actorFullName);

        it('returns all actors when the selection is empty', async () => {
            await twoActors();
            expect(fullNames(await readConfigFile(emptyActorSelection))).toEqual(['team/actor-a', 'team/actor-b']);
        });

        it('keeps only the selected actors', async () => {
            await twoActors();
            expect(fullNames(await readConfigFile({ actors: ['team/actor-a'], ignore: [] }))).toEqual(['team/actor-a']);
        });

        it('drops ignored actors', async () => {
            await twoActors();
            expect(fullNames(await readConfigFile({ actors: [], ignore: ['team/actor-a'] }))).toEqual(['team/actor-b']);
        });

        it('throws on an unknown actor name', async () => {
            await twoActors();
            await expect(readConfigFile({ actors: ['team/nope'], ignore: [] })).rejects.toThrow(
                'do not exist: team/nope',
            );
        });
    });
});
