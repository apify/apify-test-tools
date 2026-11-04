import type { Actor, ActorClient } from 'apify-client';
import { ApifyClient } from 'apify-client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { _private } from '../../lib/lib.js';

vi.hoisted(() => {
    vi.stubEnv('TESTER_APIFY_TOKEN', 'standby-test-token');
});

const { createStartStandbyFn, getStandbyActor } = _private;
const standbyUrl = 'https://test-actor.apify.actor';

afterAll(() => vi.unstubAllEnvs());

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

        const callStandby = createStartStandbyFn(await getStandbyActor('owner/actor', build));
        const result = await callStandby({
            input: { query: 'test' },
            path: '/search?limit=2',
            headers: { 'Content-Type': 'application/json', 'x-actor-build': 'wrong-build', 'X-Custom': 'value' },
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
        expect(options.headers.get('Content-Type')).toBe('application/json');
        expect(options.headers.get('X-Custom')).toBe('value');
        expect(result).toEqual({ data: { results: [1, 2] }, status: 201, headers: response.headers });
        expect(tasks).not.toHaveBeenCalled();
        expect(task).not.toHaveBeenCalled();
    });

    it('falls back to the configured standby build tag', async () => {
        mockActor({ standbyUrl, actorStandby: { isEnabled: true, build: 'latest' } });
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);

        await createStartStandbyFn(await getStandbyActor('actor'))({ input: {} });

        expect(fetchMock.mock.calls[0][0]).toBe(standbyUrl);
        expect(fetchMock.mock.calls[0][1].headers.get('X-Actor-Build')).toBe('latest');
    });

    it('leaves build selection to the platform when no standby build is configured', async () => {
        mockActor({ standbyUrl });
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);

        await createStartStandbyFn(await getStandbyActor('actor'))({ input: {} });

        expect(fetchMock.mock.calls[0][1].headers.has('X-Actor-Build')).toBe(false);
    });

    it('returns an error response for the test to assert', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"bad input"}', { status: 400 })));

        const result = await createStartStandbyFn({ standbyUrl, build: 'latest' })({ input: {} });

        expect(result.status).toBe(400);
        expect(result.data).toEqual({ error: 'bad input' });
    });

    it('propagates fetch failures', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection failed')));

        await expect(createStartStandbyFn({ standbyUrl })({ input: {} })).rejects.toThrow('connection failed');
    });

    it('rejects a missing Actor', async () => {
        mockActor(undefined);

        await expect(getStandbyActor('missing')).rejects.toThrow('Actor "missing" not found');
    });

    it('rejects an Actor without a standby URL', async () => {
        mockActor({});

        await expect(getStandbyActor('actor')).rejects.toThrow('Actor "actor" doesn\'t support standby mode');
    });
});
