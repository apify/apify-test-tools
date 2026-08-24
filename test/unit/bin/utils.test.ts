import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONFIG_FILE_NAME, readConfigFile, readNotifiersConfig } from '../../../bin/utils.js';

const { fsMock } = vi.hoisted(() => ({
    fsMock: {
        readFile: vi.fn(),
    },
}));

vi.mock('node:fs/promises', () => ({ default: fsMock }));

afterEach(() => vi.restoreAllMocks());

const emptyActorSelection = { actors: [], ignore: [] };

const validConfig = (actors: object[]) => JSON.stringify({ actors });
const actorJson = (fields: Record<string, unknown> = {}) => JSON.stringify(fields);

const expectFileRead = (filePath: string) => {
    expect(fsMock.readFile).toHaveBeenCalledWith(filePath, expect.anything());
};

const mockFiles = (files: Record<string, string>) => {
    fsMock.readFile.mockImplementation(async (filePath: string) => {
        if (filePath in files) return Promise.resolve(files[filePath]);
        return Promise.reject(new Error(`ENOENT: ${filePath}`));
    });
};

describe('readConfigFile', () => {
    it('returns correct ActorConfig[] for a valid config', async () => {
        mockFiles({
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
        expectFileRead('actors/shopify/.actor/actor.json');
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
        mockFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: '.', actorFullName: 'apify/my-actor', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            '.actor/actor.json': actorJson({}),
        });

        const result = await readConfigFile(emptyActorSelection);
        expect(result[0].folder).toBe('');
        expectFileRead('.actor/actor.json');
    });

    it('defaults dockerContextDir to actor folder when absent from actor.json', async () => {
        mockFiles({
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
        mockFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/shopify', actorFullName: 'myteam/shopify', tokenEnvVar: 'APIFY_TOKEN' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({ dockerContextDir: '../../..' }),
        });

        const result = await readConfigFile(emptyActorSelection);
        expect(result[0].dockerContextDir).toBe('');
    });

    it('resolves contextPaths from overrideActorContext', async () => {
        mockFiles({
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
        mockFiles({
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
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));
        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('not found');
    });

    it('throws when config file contains invalid JSON', async () => {
        fsMock.readFile.mockResolvedValue('{bad json');
        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('invalid JSON');
    });

    it('throws when actors array is missing', async () => {
        fsMock.readFile.mockResolvedValue(JSON.stringify({ notActors: [] }));
        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('"actors" array');
    });

    it('throws on duplicate folders', async () => {
        mockFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/shopify', actorFullName: 'apify/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
                { folder: 'actors/shopify', actorFullName: 'other/shopify', tokenEnvVar: 'APIFY_TOKEN_OTHER' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Duplicate folder');
    });

    it('throws on duplicate folders after normalization ("." and "")', async () => {
        mockFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: '.', actorFullName: 'apify/actor-a', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
                { folder: '', actorFullName: 'other/actor-b', tokenEnvVar: 'APIFY_TOKEN_OTHER' },
            ]),
            '.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Duplicate folder');
    });

    it('throws when actor.json is missing', async () => {
        mockFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/shopify', actorFullName: 'apify/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Cannot read');
    });

    it('throws when folder is missing', async () => {
        mockFiles({
            [CONFIG_FILE_NAME]: validConfig([{ actorFullName: 'apify/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' }]),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow(/Invalid "folder"/);
    });

    it('throws when folder is not a string', async () => {
        mockFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 123, actorFullName: 'apify/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow(/Invalid "folder"/);
    });

    it('throws when actorFullName is missing', async () => {
        mockFiles({
            [CONFIG_FILE_NAME]: validConfig([{ folder: 'actors/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' }]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Invalid "actorFullName"');
    });

    it('throws when actorFullName has no slash', async () => {
        mockFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/shopify', actorFullName: 'shopify-scraper', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Invalid "actorFullName"');
    });

    it('throws when actorFullName has empty parts', async () => {
        mockFiles({
            [CONFIG_FILE_NAME]: validConfig([
                { folder: 'actors/shopify', actorFullName: '/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile(emptyActorSelection)).rejects.toThrow('Invalid "actorFullName"');
    });

    it('throws when overrideActorContext is not an array', async () => {
        mockFiles({
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
        mockFiles({
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
        mockFiles({
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
        mockFiles({
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
        mockFiles({
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
        mockFiles({
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
        mockFiles({
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
        const twoActors = () =>
            mockFiles({
                [CONFIG_FILE_NAME]: validConfig([
                    { folder: 'actors/a', actorFullName: 'team/a', tokenEnvVar: 'TOKEN' },
                    { folder: 'actors/b', actorFullName: 'team/b', tokenEnvVar: 'TOKEN' },
                ]),
                'actors/a/.actor/actor.json': actorJson({}),
                'actors/b/.actor/actor.json': actorJson({}),
            });

        const fullNames = (result: { actorFullName: string }[]) => result.map((c) => c.actorFullName);

        it('returns all actors when the selection is empty', async () => {
            twoActors();
            expect(fullNames(await readConfigFile(emptyActorSelection))).toEqual(['team/a', 'team/b']);
        });

        it('keeps only the selected actors', async () => {
            twoActors();
            expect(fullNames(await readConfigFile({ actors: ['team/a'], ignore: [] }))).toEqual(['team/a']);
        });

        it('drops ignored actors', async () => {
            twoActors();
            expect(fullNames(await readConfigFile({ actors: [], ignore: ['team/a'] }))).toEqual(['team/b']);
        });

        it('throws on an unknown actor name', async () => {
            twoActors();
            await expect(readConfigFile({ actors: ['team/nope'], ignore: [] })).rejects.toThrow(
                'do not exist: team/nope',
            );
        });
    });
});

describe('readNotifiersConfig', () => {
    it('returns the notifiers object from the config file', async () => {
        mockFiles({
            [CONFIG_FILE_NAME]: JSON.stringify({ actors: [], notifiers: { slack: { tokenEnvVar: 'SLACK_TOKEN' } } }),
        });

        expect(await readNotifiersConfig()).toEqual({ slack: { tokenEnvVar: 'SLACK_TOKEN' } });
    });

    it('returns undefined when the config file has no notifiers key', async () => {
        mockFiles({ [CONFIG_FILE_NAME]: validConfig([]) });

        expect(await readNotifiersConfig()).toBeUndefined();
    });

    it('throws when the config file is missing', async () => {
        mockFiles({});

        await expect(readNotifiersConfig()).rejects.toThrow(`Config file "${CONFIG_FILE_NAME}" not found`);
    });

    it('throws when the config file contains invalid JSON', async () => {
        mockFiles({ [CONFIG_FILE_NAME]: '{invalid' });

        await expect(readNotifiersConfig()).rejects.toThrow(`Config file "${CONFIG_FILE_NAME}" contains invalid JSON`);
    });
});
