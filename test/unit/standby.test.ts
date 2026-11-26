import type { Actor, ActorClient } from 'apify-client';
import { ApifyClient } from 'apify-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { _private } from '../../lib/lib.js';

const { createStartStandbyFn, getStandbyActor } = _private;
const standbyUrl = 'https://test-actor.apify.actor';
const apifyClient = new ApifyClient({ token: 'standby-test-token' });

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const mockActor = (actor: (Partial<Actor> & { standbyUrl?: string }) | undefined) => {
    return vi.spyOn(ApifyClient.prototype, 'actor').mockReturnValue({
        get: vi.fn().mockResolvedValue(actor),
    } as unknown as ActorClient);
};

describe('standby Actor requests', () => {
    it.each(['0.12.34', 'beta'])('targets build %s directly without creating or deleting tasks', async (build) => {
        const actor = mockActor({ standbyUrl, actorStandby: { isEnabled: true, build: 'latest' } });
        const tasks = vi.spyOn(ApifyClient.prototype, 'tasks');
        const task = vi.spyOn(ApifyClient.prototype, 'task');
        const response = new Response(JSON.stringify({ results: [1, 2] }), {
            status: 201,
            headers: { 'X-Test-Response': 'preserved' },
        });
        const fetchMock = vi.fn().mockResolvedValue(response);
        vi.stubGlobal('fetch', fetchMock);

        const callStandby = createStartStandbyFn({
            ...(await getStandbyActor(apifyClient, 'owner/actor', build)),
            apifyClient,
        });
        const result = await callStandby({
            input: { query: 'test' },
            path: '/search?limit=2',
            headers: { 'content-type': 'application/x-ndjson', 'x-actor-build': 'wrong-build', 'X-Custom': 'value' },
        });

        expect(actor).toHaveBeenCalledWith('owner/actor');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe(`${standbyUrl}/search?limit=2`);
        expect(options.method).toBe('POST');
        expect(options.body).toBe(JSON.stringify({ query: 'test' }));
        expect(options.headers.get('X-Actor-Build')).toBe(build);
        expect([...options.headers.keys()].filter((key) => key === 'x-actor-build')).toHaveLength(1);
        expect(options.headers.get('Authorization')).toBe('Bearer standby-test-token');
        expect(options.headers.get('Content-Type')).toBe('application/x-ndjson');
        expect(options.headers.get('X-Custom')).toBe('value');
        expect(result).toEqual({
            data: { results: [1, 2] },
            body: '{"results":[1,2]}',
            status: 201,
            headers: response.headers,
        });
        expect(tasks).not.toHaveBeenCalled();
        expect(task).not.toHaveBeenCalled();
    });

    it('sends the input as JSON by default', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);

        await createStartStandbyFn({ standbyUrl, apifyClient })({ input: {} });

        expect(fetchMock.mock.calls[0][1].headers.get('Content-Type')).toBe('application/json');
    });

    // The default build needs no header, and a header would need write access to the Actor even for that build
    it.each([
        ['a configured standby build', { isEnabled: true, build: 'latest' }],
        ['no configured standby build', undefined],
    ])('sends no build on the default build, with %s', async (_, actorStandby) => {
        mockActor({ standbyUrl, actorStandby });
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);

        await createStartStandbyFn({ ...(await getStandbyActor(apifyClient, 'actor')), apifyClient })({ input: {} });

        expect(fetchMock.mock.calls[0][0]).toBe(standbyUrl);
        expect(fetchMock.mock.calls[0][1].headers.has('X-Actor-Build')).toBe(false);
    });

    it('returns an error response for the test to assert', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"bad input"}', { status: 400 })));

        const result = await createStartStandbyFn({ standbyUrl, build: 'latest', apifyClient })({ input: {} });

        expect(result.status).toBe(400);
        expect(result.data).toEqual({ error: 'bad input' });
    });

    it.each([
        ['an HTML error page', '<html><body>502 Bad Gateway</body></html>', 502],
        ['an empty body', '', 204],
    ])('returns %s as the raw body, without data', async (_, text, status) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(text || null, { status })));

        const result = await createStartStandbyFn({ standbyUrl, apifyClient })({ input: {} });

        expect(result).toMatchObject({ status, body: text, data: undefined });
    });

    it('propagates fetch failures', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection failed')));

        await expect(createStartStandbyFn({ standbyUrl, apifyClient })({ input: {} })).rejects.toThrow(
            'connection failed',
        );
    });

    it('rejects a missing Actor', async () => {
        mockActor(undefined);

        await expect(getStandbyActor(apifyClient, 'missing')).rejects.toThrow('Actor "missing" not found');
    });

    it('rejects an Actor without a standby URL', async () => {
        mockActor({});

        await expect(getStandbyActor(apifyClient, 'actor')).rejects.toThrow(
            'Actor "actor" doesn\'t support standby mode',
        );
    });
});
