import type { Actor, ActorClient } from 'apify-client';
import { ApifyClient } from 'apify-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { _private } from '../../lib/lib.js';

const { createSendRequestToServerFn, getServerInterface } = _private;
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

/** A fetch that answers `text`, and the request it got: its URL as a string and its options */
const stubFetch = (response: Response = new Response('{}')) => {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    return () => {
        const [url, options] = fetchMock.mock.calls[0];
        return { url: `${url}`, options, headers: options.headers };
    };
};

const sendRequestToServer = createSendRequestToServerFn({ url: serverInterfaceUrl, apifyClient });

describe('server interface requests', () => {
    it.each(['0.12.34', 'beta'])('targets build %s directly without creating or deleting tasks', async (build) => {
        const actor = mockActor({ standbyUrl: serverInterfaceUrl, actorStandby: { isEnabled: true, build: 'latest' } });
        const tasks = vi.spyOn(ApifyClient.prototype, 'tasks');
        const task = vi.spyOn(ApifyClient.prototype, 'task');
        const response = new Response(JSON.stringify({ results: [1, 2] }), {
            status: 201,
            headers: { 'X-Test-Response': 'preserved' },
        });
        const request = stubFetch(response);

        const send = createSendRequestToServerFn({
            ...(await getServerInterface(apifyClient, 'owner/actor', build)),
            apifyClient,
        });
        const result = await send({
            path: '/search',
            body: { query: 'test' },
            headers: { 'content-type': 'application/x-ndjson', 'x-actor-build': 'wrong-build', 'X-Custom': 'value' },
        });

        expect(actor).toHaveBeenCalledWith('owner/actor');
        const { url, options, headers } = request();
        expect(url).toBe(`${serverInterfaceUrl}/search`);
        expect(options.method).toBe('POST');
        expect(options.body).toBe(JSON.stringify({ query: 'test' }));
        expect(headers.get('X-Actor-Build')).toBe(build);
        expect([...headers.keys()].filter((key) => key === 'x-actor-build')).toHaveLength(1);
        expect(headers.get('Authorization')).toBe('Bearer server-interface-test-token');
        expect(headers.get('Content-Type')).toBe('application/x-ndjson');
        expect(headers.get('X-Custom')).toBe('value');
        expect(result).toEqual({
            data: { results: [1, 2] },
            text: '{"results":[1,2]}',
            status: 201,
            headers: response.headers,
        });
        expect(tasks).not.toHaveBeenCalled();
        expect(task).not.toHaveBeenCalled();
    });

    it('sends an object body as JSON, POST by default', async () => {
        const request = stubFetch();
        await sendRequestToServer({ body: { a: 1 } });
        const { options, headers } = request();
        expect(options.method).toBe('POST');
        expect(options.body).toBe('{"a":1}');
        expect(headers.get('Content-Type')).toBe('application/json');
    });

    it.each([
        ['a string', 'plain text'],
        ['a Buffer', Buffer.from('bytes')],
        ['URLSearchParams', new URLSearchParams({ a: '1' })],
        ['FormData', new FormData()],
        ['a Blob', new Blob(['blob'])],
    ])('sends %s as it is, without a JSON content type', async (_, body) => {
        const request = stubFetch();
        await sendRequestToServer({ body, headers: { 'Content-Type': 'text/csv' } });
        expect(request().options.body).toBe(body);
        expect(request().headers.get('Content-Type')).toBe('text/csv');

        const bare = stubFetch();
        await sendRequestToServer({ body });
        expect(bare().headers.get('Content-Type')).toBeNull();
    });

    it('sends a GET without a body, and the method given otherwise', async () => {
        const request = stubFetch();
        await sendRequestToServer();
        expect(request().options).toMatchObject({ method: 'GET', body: undefined });
        expect(request().url).toBe(`${serverInterfaceUrl}/`);

        const put = stubFetch();
        await sendRequestToServer({ method: 'PUT', body: 'x' });
        expect(put().options.method).toBe('PUT');
    });

    it('adds the query parameters to the path, once per value, keeping a query string in the path', async () => {
        const request = stubFetch();
        await sendRequestToServer({
            path: 'search?lang=en',
            query: { q: 'a b', limit: 3, exact: false, tag: ['x', 'y'], skipped: undefined },
        });
        expect(request().url).toBe(`${serverInterfaceUrl}/search?lang=en&q=a+b&limit=3&exact=false&tag=x&tag=y`);
    });

    // The default build needs no header, and a header would need write access to the Actor even for that build
    it.each([
        ['a configured server interface build', { isEnabled: true, build: 'latest' }],
        ['no configured server interface build', undefined],
    ])('sends no build on the default build, with %s', async (_, actorStandby) => {
        mockActor({ standbyUrl: serverInterfaceUrl, actorStandby });
        const request = stubFetch();

        await createSendRequestToServerFn({ ...(await getServerInterface(apifyClient, 'actor')), apifyClient })();

        expect(request().headers.has('X-Actor-Build')).toBe(false);
    });

    it('returns an error response for the test to assert', async () => {
        stubFetch(new Response('{"error":"bad input"}', { status: 400 }));

        const result = await sendRequestToServer({ body: {} });

        expect(result.status).toBe(400);
        expect(result.data).toEqual({ error: 'bad input' });
    });

    it.each([
        ['an HTML error page', '<html><body>502 Bad Gateway</body></html>', 502],
        ['an empty body', '', 204],
    ])('returns %s as the raw text, without data', async (_, text, status) => {
        stubFetch(new Response(text || null, { status }));

        const result = await sendRequestToServer({ body: {} });

        expect(result).toMatchObject({ status, text, data: undefined });
    });

    it('propagates fetch failures', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection failed')));

        await expect(sendRequestToServer({ body: {} })).rejects.toThrow('connection failed');
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
