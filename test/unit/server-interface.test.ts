import type { Actor, ActorClient } from 'apify-client';
import { ApifyClient } from 'apify-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { _private } from '../../lib/lib.js';

const { createFetchServerFn, getServerInterface } = _private;
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

/** Stubs the global fetch with `response`, and returns the request it got: its URL, its options and headers */
const stubFetch = (response: Response = new Response('{}')) => {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    return () => {
        const [url, options] = fetchMock.mock.calls[0];
        return { url: `${url}`, options, headers: options.headers };
    };
};

const fetchServer = createFetchServerFn({ url: serverInterfaceUrl, apifyClient });

describe('fetchServer', () => {
    it.each(['0.12.34', 'beta'])('targets build %s directly without creating or deleting tasks', async (build) => {
        const actor = mockActor({ standbyUrl: serverInterfaceUrl, actorStandby: { isEnabled: true, build: 'latest' } });
        const tasks = vi.spyOn(ApifyClient.prototype, 'tasks');
        const task = vi.spyOn(ApifyClient.prototype, 'task');
        const response = new Response('{"results":[1,2]}', { status: 201 });
        const request = stubFetch(response);

        const fetchBuild = createFetchServerFn({
            ...(await getServerInterface(apifyClient, 'owner/actor', build)),
            apifyClient,
        });
        const result = await fetchBuild('/search', {
            method: 'POST',
            body: '{"query":"test"}',
            headers: { 'x-actor-build': 'wrong-build', 'Content-Type': 'application/json' },
        });

        expect(actor).toHaveBeenCalledWith('owner/actor');
        const { url, options, headers } = request();
        expect(url).toBe(`${serverInterfaceUrl}/search`);
        expect(options).toMatchObject({ method: 'POST', body: '{"query":"test"}' });
        expect(headers.get('X-Actor-Build')).toBe(build);
        expect(headers.get('Authorization')).toBe('Bearer server-interface-test-token');
        expect(headers.get('Content-Type')).toBe('application/json');
        // The response as fetch returned it
        expect(result).toBe(response);
        expect(tasks).not.toHaveBeenCalled();
        expect(task).not.toHaveBeenCalled();
    });

    // The default build needs no header, and a header would need write access to the Actor even for that build
    it.each([
        ['a configured server interface build', { isEnabled: true, build: 'latest' }],
        ['no configured server interface build', undefined],
    ])('sends no build on the default build, with %s, even one the caller sets', async (_, actorStandby) => {
        mockActor({ standbyUrl: serverInterfaceUrl, actorStandby });
        const request = stubFetch();

        const fetchDefault = createFetchServerFn({ ...(await getServerInterface(apifyClient, 'actor')), apifyClient });
        await fetchDefault('/', { headers: { 'X-Actor-Build': '1.2.3' } });

        expect(request().headers.has('X-Actor-Build')).toBe(false);
    });

    it("resolves the path against the server's URL, keeping its query string", async () => {
        const request = stubFetch();
        await fetchServer('search?q=a+b&limit=3');
        expect(request().url).toBe(`${serverInterfaceUrl}/search?q=a+b&limit=3`);

        const root = stubFetch();
        await fetchServer();
        expect(root().url).toBe(`${serverInterfaceUrl}/`);
        expect(root().options.method).toBeUndefined();
    });

    it('passes the init on as fetch takes it', async () => {
        const request = stubFetch();
        const { signal } = new AbortController();
        const body = new URLSearchParams({ a: '1' });
        await fetchServer('/form', { method: 'PUT', body, signal, redirect: 'manual' });
        expect(request().options).toMatchObject({ method: 'PUT', body, signal, redirect: 'manual' });
    });

    it("keeps the caller's Authorization, e.g. to test another token", async () => {
        const request = stubFetch();
        await fetchServer('/', { headers: { Authorization: 'Bearer other' } });
        expect(request().headers.get('Authorization')).toBe('Bearer other');
    });

    it('propagates fetch failures', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection failed')));

        await expect(fetchServer('/')).rejects.toThrow('connection failed');
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
