import { describe, expect, it, vi } from 'vitest';

import { withTestTokens } from '../../../bin/actor-ids.js';
import { logger } from '../../../bin/logger.js';

type Options = Parameters<typeof withTestTokens>[1];
type Client = ReturnType<NonNullable<Options['createClient']>>;

/** Each token sees only the Actors of its own account, by full name and by raw ID, as the API does */
const ACCOUNTS: Record<string, { id: string; username: string; name: string }[]> = {
    'owner-token': [{ id: 'rawA', username: 'owner', name: 'a' }],
    'partner-token': [{ id: 'rawP', username: 'partner', name: 'p' }],
};

const fakeClients = () => {
    const actor = vi.fn((token: string, actorId: string) => ({
        get: async () =>
            ACCOUNTS[token]?.find(({ id, username, name }) => actorId === id || actorId === `${username}/${name}`),
    }));
    const createClient = vi.fn((token: string) => ({ actor: (actorId: string) => actor(token, actorId) }) as Client);
    return { actor, createClient };
};

const testTokenEnvVars = new Map([
    ['owner/a', 'APIFY_TOKEN_OWNER'],
    ['partner/p', 'APIFY_TOKEN_PARTNER'],
]);
const env = { APIFY_TOKEN_OWNER: 'owner-token', APIFY_TOKEN_PARTNER: 'partner-token' };

const resolve = async (targets: Parameters<typeof withTestTokens>[0], options: Partial<Options> = {}) => {
    const clients = fakeClients();
    const result = await withTestTokens(targets, {
        testTokenEnvVars,
        env,
        createClient: clients.createClient,
        ...options,
    });
    return { result, ...clients };
};

describe('withTestTokens', () => {
    it("adds each Actor's test token and raw ID, looked up with that token, as get-actor-configs lists them", async () => {
        const { result, actor } = await resolve([{ actorFullName: 'owner/a' }, { actorFullName: 'partner/p' }]);
        expect(result).toEqual([
            { actorFullName: 'owner/a', actorRawId: 'rawA', testTokenEnvVar: 'APIFY_TOKEN_OWNER' },
            { actorFullName: 'partner/p', actorRawId: 'rawP', testTokenEnvVar: 'APIFY_TOKEN_PARTNER' },
        ]);
        expect(actor).toHaveBeenCalledWith('owner-token', 'owner/a');
        expect(actor).toHaveBeenCalledWith('partner-token', 'partner/p');
    });

    it('creates one client per token', async () => {
        const { createClient } = await resolve(
            [{ actorFullName: 'owner/a' }, { actorFullName: 'owner/b' }, { actorFullName: 'partner/p' }],
            { testTokenEnvVars: new Map([...testTokenEnvVars, ['owner/b', 'APIFY_TOKEN_OWNER']]) },
        );
        expect(createClient).toHaveBeenCalledTimes(2);
    });

    it("looks up the raw ID only with the Actor's own token, never another Actor's", async () => {
        // owner-token can't see partner/p, partner-token can't see owner/a
        const { result, actor } = await resolve([{ actorFullName: 'partner/p' }]);
        expect(result).toEqual([
            { actorFullName: 'partner/p', actorRawId: 'rawP', testTokenEnvVar: 'APIFY_TOKEN_PARTNER' },
        ]);
        expect(actor.mock.calls).toEqual([['partner-token', 'partner/p']]);
    });

    it('keeps the IDs of a build and does not look them up', async () => {
        const build = { actorFullName: 'owner/a', buildId: 'b1', actorRawId: 'raw1', buildNumber: '0.99.1' };
        const { result, createClient } = await resolve([build]);
        expect(result).toEqual([{ ...build, testTokenEnvVar: 'APIFY_TOKEN_OWNER' }]);
        expect(createClient).not.toHaveBeenCalled();
    });

    it('keeps an Actor its token cannot see as listed, instead of failing the run', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const { result } = await resolve([{ actorFullName: 'owner/missing' }, { actorFullName: 'owner/a' }], {
            testTokenEnvVars: new Map([...testTokenEnvVars, ['owner/missing', 'APIFY_TOKEN_OWNER']]),
        });
        expect(result).toEqual([
            { actorFullName: 'owner/missing', testTokenEnvVar: 'APIFY_TOKEN_OWNER' },
            { actorFullName: 'owner/a', actorRawId: 'rawA', testTokenEnvVar: 'APIFY_TOKEN_OWNER' },
        ]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('owner/missing not found, or APIFY_TOKEN_OWNER'));
        warn.mockRestore();
    });

    it('passes on an Actor without a token in the config or an unset one with a warning, so only its tests fail', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const { result, createClient } = await resolve(
            [{ actorFullName: 'stranger/x' }, { actorFullName: 'partner/p' }, { actorFullName: 'owner/a' }],
            { env: { APIFY_TOKEN_OWNER: 'owner-token' } },
        );
        expect(result).toEqual([
            { actorFullName: 'stranger/x' },
            { actorFullName: 'partner/p', testTokenEnvVar: 'APIFY_TOKEN_PARTNER' },
            { actorFullName: 'owner/a', actorRawId: 'rawA', testTokenEnvVar: 'APIFY_TOKEN_OWNER' },
        ]);
        expect(createClient).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls.map(([message]) => message)).toEqual([
            'Actor stranger/x is not in apify-test-tools.config.json, so its tests will fail.',
            'APIFY_TOKEN_PARTNER is not set, so the tests of partner/p will fail.',
        ]);
        warn.mockRestore();
    });

    it('looks up and tests the Actors without a token of their own with TESTER_APIFY_TOKEN when it is set', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const { result, actor } = await resolve([{ actorFullName: 'stranger/x' }, { actorFullName: 'partner/p' }], {
            env: { TESTER_APIFY_TOKEN: 'partner-token' },
        });
        // Each keeps the token the config names for it, the lib falls back the same way
        expect(result).toEqual([
            { actorFullName: 'stranger/x' },
            { actorFullName: 'partner/p', actorRawId: 'rawP', testTokenEnvVar: 'APIFY_TOKEN_PARTNER' },
        ]);
        expect(actor).toHaveBeenCalledWith('partner-token', 'partner/p');
        expect(warn.mock.calls.map(([message]) => message)).toEqual([
            "Actor stranger/x not found, or TESTER_APIFY_TOKEN can't access it. Tests that name it by its raw ID will be skipped.",
            'Actor stranger/x is not in apify-test-tools.config.json, so its tests run with TESTER_APIFY_TOKEN.',
            'APIFY_TOKEN_PARTNER is not set, so the tests of partner/p run with TESTER_APIFY_TOKEN.',
        ]);
        warn.mockRestore();
    });
});
