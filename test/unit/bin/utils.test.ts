import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConfigFile } from '../../../bin/utils.js';

const { fsMock } = vi.hoisted(() => ({
    fsMock: {
        readFile: vi.fn(),
    },
}));

vi.mock('node:fs/promises', () => ({ default: fsMock }));

afterEach(() => vi.restoreAllMocks());

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
            '.test-tools-actors-config.json': validConfig([
                { folder: 'actors/shopify', actorName: 'myteam/shopify-scraper', tokenEnvVar: 'APIFY_TOKEN_MYTEAM' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({ dockerContextDir: '../../..' }),
        });

        const result = await readConfigFile();
        expectFileRead('actors/shopify/.actor/actor.json');
        expect(result).toEqual([
            {
                actorName: 'myteam/shopify-scraper',
                folder: 'actors/shopify',
                tokenEnvVar: 'APIFY_TOKEN_MYTEAM',
                dockerContextDir: '',
                contextPaths: [''],
            },
        ]);
    });

    it('normalizes folder "." to ""', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: '.', actorName: 'apify/my-actor', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            '.actor/actor.json': actorJson({}),
        });

        const result = await readConfigFile();
        expect(result[0].folder).toBe('');
        expectFileRead('.actor/actor.json');
    });

    it('defaults dockerContextDir to actor folder when absent from actor.json', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: 'actors/web-scraper', actorName: 'apify/web-scraper', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            'actors/web-scraper/.actor/actor.json': actorJson({}),
        });

        const result = await readConfigFile();
        expect(result[0].dockerContextDir).toBe('actors/web-scraper');
        expect(result[0].contextPaths).toEqual(['actors/web-scraper']);
    });

    it('resolves dockerContextDir relative to .actor/ folder', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: 'actors/shopify', actorName: 'myteam/shopify', tokenEnvVar: 'APIFY_TOKEN' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({ dockerContextDir: '../../..' }),
        });

        const result = await readConfigFile();
        expect(result[0].dockerContextDir).toBe('');
    });

    it('resolves contextPaths from overrideActorContext', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                {
                    folder: 'actors/shopify',
                    actorName: 'myteam/shopify',
                    tokenEnvVar: 'APIFY_TOKEN',
                    overrideActorContext: ['actors/shopify', 'packages'],
                },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({ dockerContextDir: '../../..' }),
        });

        const result = await readConfigFile();
        expect(result[0].contextPaths).toEqual(['actors/shopify', 'packages']);
    });

    it('handles multiple actors', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: 'actors/web-scraper', actorName: 'apify/web-scraper', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
                {
                    folder: 'actors/email-sender',
                    actorName: 'other-team/email-sender',
                    tokenEnvVar: 'APIFY_TOKEN_OTHER_TEAM',
                },
            ]),
            'actors/web-scraper/.actor/actor.json': actorJson({}),
            'actors/email-sender/.actor/actor.json': actorJson({}),
        });

        const result = await readConfigFile();
        expect(result).toHaveLength(2);
        expect(result[0].actorName).toBe('apify/web-scraper');
        expect(result[1].actorName).toBe('other-team/email-sender');
    });

    it('throws when config file is missing', async () => {
        fsMock.readFile.mockRejectedValue(new Error('ENOENT'));
        await expect(readConfigFile()).rejects.toThrow('not found');
    });

    it('throws when config file contains invalid JSON', async () => {
        fsMock.readFile.mockResolvedValue('{bad json');
        await expect(readConfigFile()).rejects.toThrow('invalid JSON');
    });

    it('throws when actors array is missing', async () => {
        fsMock.readFile.mockResolvedValue(JSON.stringify({ notActors: [] }));
        await expect(readConfigFile()).rejects.toThrow('"actors" array');
    });

    it('throws on duplicate folders', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: 'actors/shopify', actorName: 'apify/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
                { folder: 'actors/shopify', actorName: 'other/shopify', tokenEnvVar: 'APIFY_TOKEN_OTHER' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile()).rejects.toThrow('Duplicate folder');
    });

    it('throws on duplicate folders after normalization ("." and "")', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: '.', actorName: 'apify/actor-a', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
                { folder: '', actorName: 'other/actor-b', tokenEnvVar: 'APIFY_TOKEN_OTHER' },
            ]),
            '.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile()).rejects.toThrow('Duplicate folder');
    });

    it('throws when actor.json is missing', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: 'actors/shopify', actorName: 'apify/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
        });

        await expect(readConfigFile()).rejects.toThrow('Cannot read');
    });

    it('throws when actorName is missing', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: 'actors/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile()).rejects.toThrow('Invalid "actorName"');
    });

    it('throws when actorName has no slash', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: 'actors/shopify', actorName: 'shopify-scraper', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile()).rejects.toThrow('Invalid "actorName"');
    });

    it('throws when actorName has empty parts', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: 'actors/shopify', actorName: '/shopify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile()).rejects.toThrow('Invalid "actorName"');
    });

    it('throws when overrideActorContext is not an array', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                {
                    folder: 'actors/shopify',
                    actorName: 'myteam/shopify',
                    tokenEnvVar: 'APIFY_TOKEN',
                    overrideActorContext: 'packages',
                },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile()).rejects.toThrow('Invalid "overrideActorContext"');
    });

    it('throws when overrideActorContext contains non-strings', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                {
                    folder: 'actors/shopify',
                    actorName: 'myteam/shopify',
                    tokenEnvVar: 'APIFY_TOKEN',
                    overrideActorContext: [123],
                },
            ]),
            'actors/shopify/.actor/actor.json': actorJson({}),
        });

        await expect(readConfigFile()).rejects.toThrow('Invalid "overrideActorContext"');
    });
});
