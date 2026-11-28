import type { Actor, ActorClient } from 'apify-client';
import { ApifyClient } from 'apify-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { _private } from '../../lib/lib.js';

const { createCallServerInterfaceFn, getServerInterface } = _private;
const serverInterfaceUrl = 'https://test-actor.apify.actor';
const apifyClient = new ApifyClient({ token: 'server-interface-test-token' });

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

// The platform API still calls the server interface URL `standbyUrl`
const mockActor = (actor: (Partial<Actor> & { standbyUrl?: string }) | undefined) => {
    return vi.spyOn(ApifyClient.prototype, 'actor').mockReturnValue({
        get: vi.fn().mockResolvedValue(actor),
    } as unknown as ActorClient);
};

describe('server interface requests', () => {
    it.each(['0.12.34', 'beta'])('targets build %s directly without creating or deleting tasks', async (build) => {
        const actor = mockActor({ standbyUrl: serverInterfaceUrl, actorStandby: { isEnabled: true, build: 'latest' } });
        const tasks = vi.spyOn(ApifyClient.prototype, 'tasks');
        const task = vi.spyOn(ApifyClient.prototype, 'task');
        const response = new Response(JSON.stringify({ results: [1, 2] }), {
            status: 201,
            headers: { 'X-Test-Response': 'preserved' },
        });
        const fetchMock = vi.fn().mockResolvedValue(response);
        vi.stubGlobal('fetch', fetchMock);

        const callServerInterface = createCallServerInterfaceFn({
            ...(await getServerInterface(apifyClient, 'owner/actor', build)),
            apifyClient,
        });
        const result = await callServerInterface({
            input: { query: 'test' },
            path: '/search?limit=2',
            headers: { 'content-type': 'application/x-ndjson', 'x-actor-build': 'wrong-build', 'X-Custom': 'value' },
        });

        expect(actor).toHaveBeenCalledWith('owner/actor');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe(`${serverInterfaceUrl}/search?limit=2`);
        expect(options.method).toBe('POST');
        expect(options.body).toBe(JSON.stringify({ query: 'test' }));
        expect(options.headers.get('X-Actor-Build')).toBe(build);
        expect([...options.headers.keys()].filter((key) => key === 'x-actor-build')).toHaveLength(1);
        expect(options.headers.get('Authorization')).toBe('Bearer server-interface-test-token');
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

        await createCallServerInterfaceFn({ url: serverInterfaceUrl, apifyClient })({ input: {} });

        expect(fetchMock.mock.calls[0][1].headers.get('Content-Type')).toBe('application/json');
    });

    // The default build needs no header, and a header would need write access to the Actor even for that build
    it.each([
        ['a configured server interface build', { isEnabled: true, build: 'latest' }],
        ['no configured server interface build', undefined],
    ])('sends no build on the default build, with %s', async (_, actorStandby) => {
        mockActor({ standbyUrl: serverInterfaceUrl, actorStandby });
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);

        await createCallServerInterfaceFn({ ...(await getServerInterface(apifyClient, 'actor')), apifyClient })({
            input: {},
        });

        expect(fetchMock.mock.calls[0][0]).toBe(serverInterfaceUrl);
        expect(fetchMock.mock.calls[0][1].headers.has('X-Actor-Build')).toBe(false);
    });

    it('returns an error response for the test to assert', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"bad input"}', { status: 400 })));

        const result = await createCallServerInterfaceFn({ url: serverInterfaceUrl, build: 'latest', apifyClient })({
            input: {},
        });

        expect(result.status).toBe(400);
        expect(result.data).toEqual({ error: 'bad input' });
    });

    it.each([
        ['an HTML error page', '<html><body>502 Bad Gateway</body></html>', 502],
        ['an empty body', '', 204],
    ])('returns %s as the raw body, without data', async (_, text, status) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(text || null, { status })));

        const result = await createCallServerInterfaceFn({ url: serverInterfaceUrl, apifyClient })({ input: {} });

        expect(result).toMatchObject({ status, body: text, data: undefined });
    });

    it('propagates fetch failures', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection failed')));

        await expect(
            createCallServerInterfaceFn({ url: serverInterfaceUrl, apifyClient })({ input: {} }),
        ).rejects.toThrow('connection failed');
    });

    it('rejects a missing Actor', async () => {
        mockActor(undefined);

        await expect(getServerInterface(apifyClient, 'missing')).rejects.toThrow('Actor "missing" not found');
    });

    it('rejects an Actor without a server interface', async () => {
        mockActor({});

        await expect(getServerInterface(apifyClient, 'actor')).rejects.toThrow(
            'Actor "actor" doesn\'t have a server interface',
        );
    });
});
