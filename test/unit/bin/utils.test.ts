import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateConfigFile, readConfigFile } from '../../../bin/utils.js';

const { fsMock, execSyncMock } = vi.hoisted(() => ({
    fsMock: {
        readFile: vi.fn(),
        writeFile: vi.fn(),
        access: vi.fn(),
    },
    execSyncMock: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ default: fsMock }));

vi.mock('node:child_process', () => ({
    execSync: execSyncMock,
    spawnSync: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

const validConfig = (actors: object[]) => JSON.stringify({ actors });
const actorJson = (name: string) => JSON.stringify({ name });

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
                { folder: 'actors/shopify', owner: 'myteam', tokenEnvVar: 'APIFY_TOKEN_MYTEAM' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson('shopify-scraper'),
        });

        const result = await readConfigFile();
        expectFileRead('actors/shopify/.actor/actor.json');
        expect(result).toEqual([
            {
                actorName: 'myteam/shopify-scraper',
                folder: 'actors/shopify',
                isStandalone: false,
                tokenEnvVar: 'APIFY_TOKEN_MYTEAM',
            },
        ]);
    });

    it('normalizes folder "." to ""', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: '.', owner: 'apify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            '.actor/actor.json': actorJson('my-actor'),
        });

        const result = await readConfigFile();
        expect(result[0].folder).toBe('');
        expectFileRead('.actor/actor.json');
    });

    it('defaults isStandalone to false when omitted', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: 'actors/web-scraper', owner: 'apify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            'actors/web-scraper/.actor/actor.json': actorJson('web-scraper'),
        });

        const result = await readConfigFile();
        expectFileRead('actors/web-scraper/.actor/actor.json');
        expect(result[0].isStandalone).toBe(false);
    });

    it('respects isStandalone: true', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: 'standalone/orchestrator', owner: 'apify', tokenEnvVar: 'APIFY_TOKEN_APIFY', isStandalone: true },
            ]),
            'standalone/orchestrator/.actor/actor.json': actorJson('orchestrator'),
        });

        const result = await readConfigFile();
        expectFileRead('standalone/orchestrator/.actor/actor.json');
        expect(result[0].isStandalone).toBe(true);
    });

    it('handles multiple actors', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: 'actors/web-scraper', owner: 'apify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
                { folder: 'actors/email-sender', owner: 'other-team', tokenEnvVar: 'APIFY_TOKEN_OTHER_TEAM', isStandalone: true },
            ]),
            'actors/web-scraper/.actor/actor.json': actorJson('web-scraper'),
            'actors/email-sender/.actor/actor.json': actorJson('email-sender'),
        });

        const result = await readConfigFile();
        expectFileRead('actors/web-scraper/.actor/actor.json');
        expectFileRead('actors/email-sender/.actor/actor.json');
        expect(result).toHaveLength(2);
        expect(result[0].actorName).toBe('apify/web-scraper');
        expect(result[1].actorName).toBe('other-team/email-sender');
        expect(result[1].isStandalone).toBe(true);
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
                { folder: 'actors/shopify', owner: 'apify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
                { folder: 'actors/shopify', owner: 'other-team', tokenEnvVar: 'APIFY_TOKEN_OTHER' },
            ]),
            'actors/shopify/.actor/actor.json': actorJson('shopify-scraper'),
        });

        await expect(readConfigFile()).rejects.toThrow('Duplicate folder');
    });

    it('throws on duplicate folders after normalization ("." and "")', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: '.', owner: 'apify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
                { folder: '', owner: 'other-team', tokenEnvVar: 'APIFY_TOKEN_OTHER' },
            ]),
            '.actor/actor.json': actorJson('my-actor'),
        });

        await expect(readConfigFile()).rejects.toThrow('Duplicate folder');
    });

    it('throws when actor.json is missing', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: 'actors/shopify', owner: 'apify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
        });

        await expect(readConfigFile()).rejects.toThrow('Cannot read');
    });

    it('throws when actor.json has no name field', async () => {
        mockFiles({
            '.test-tools-actors-config.json': validConfig([
                { folder: 'actors/shopify', owner: 'apify', tokenEnvVar: 'APIFY_TOKEN_APIFY' },
            ]),
            'actors/shopify/.actor/actor.json': JSON.stringify({ description: 'no name here' }),
        });

        await expect(readConfigFile()).rejects.toThrow('Missing "name"');
    });
});

describe('generateConfigFile', () => {
    it('generates config from discovered actor.json files', async () => {
        fsMock.access.mockRejectedValue(new Error('ENOENT'));
        execSyncMock.mockReturnValue(
            'actors/shopify/.actor/actor.json\nactors/amazon/.actor/actor.json\n',
        );

        await generateConfigFile();

        expect(fsMock.access).toHaveBeenCalledWith('.test-tools-actors-config.json');
        expect(fsMock.writeFile).toHaveBeenCalledOnce();
        const written = JSON.parse(fsMock.writeFile.mock.calls[0][1]);
        expect(written.actors).toHaveLength(2);
        expect(written.actors[0]).toEqual({
            folder: 'actors/shopify',
            owner: '<OWNER>',
            tokenEnvVar: '<TOKEN_ENV_VAR>',
        });
        expect(written.actors[1]).toEqual({
            folder: 'actors/amazon',
            owner: '<OWNER>',
            tokenEnvVar: '<TOKEN_ENV_VAR>',
        });
    });

    it('uses "." for root-level actor', async () => {
        fsMock.access.mockRejectedValue(new Error('ENOENT'));
        execSyncMock.mockReturnValue('.actor/actor.json\n');

        await generateConfigFile();

        const written = JSON.parse(fsMock.writeFile.mock.calls[0][1]);
        expect(written.actors[0].folder).toBe('.');
    });

    it('applies --default-owner and --default-token-var flags', async () => {
        fsMock.access.mockRejectedValue(new Error('ENOENT'));
        execSyncMock.mockReturnValue('actors/shopify/.actor/actor.json\n');

        await generateConfigFile({ defaultOwner: 'myteam', defaultTokenVar: 'MY_TOKEN' });

        const written = JSON.parse(fsMock.writeFile.mock.calls[0][1]);
        expect(written.actors[0].owner).toBe('myteam');
        expect(written.actors[0].tokenEnvVar).toBe('MY_TOKEN');
    });

    it('throws if config file already exists', async () => {
        await expect(generateConfigFile()).rejects.toThrow('already exists');
        expect(fsMock.access).toHaveBeenCalledWith('.test-tools-actors-config.json');
    });

    it('throws if no actor.json files found', async () => {
        fsMock.access.mockRejectedValue(new Error('ENOENT'));
        execSyncMock.mockReturnValue('src/main.ts\npackage.json\n');

        await expect(generateConfigFile()).rejects.toThrow('No .actor/actor.json files found');
    });

    it('warns when root actor.json exists alongside subfolder actors', async () => {
        fsMock.access.mockRejectedValue(new Error('ENOENT'));
        execSyncMock.mockReturnValue('.actor/actor.json\nactors/shopify/.actor/actor.json\n');
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { /**/ });

        await generateConfigFile();

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('root-level .actor/actor.json'));
    });
});
