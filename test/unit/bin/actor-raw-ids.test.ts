import { describe, expect, it, vi } from 'vitest';

import { withActorRawIds } from '../../../bin/actor-raw-ids.js';

type Client = NonNullable<Parameters<typeof withActorRawIds>[1]>;

/** A client that knows the Actors given, by full name, with their raw IDs */
const fakeClient = (actors: Record<string, string>) => {
    const actor = vi.fn((actorFullName: string) => ({
        get: async () => (actorFullName in actors ? { id: actors[actorFullName] } : undefined),
    }));
    return { actor } as unknown as Client & { actor: typeof actor };
};

describe('withActorRawIds', () => {
    it('adds the raw ID to the Actors listed without one, as get-actor-configs lists them', async () => {
        const client = fakeClient({ 'owner/a': 'rawA' });
        expect(await withActorRawIds([{ actorFullName: 'owner/a' }], client)).toEqual([
            { actorFullName: 'owner/a', actorRawId: 'rawA' },
        ]);
    });

    it('keeps the raw ID of a build and does not look it up', async () => {
        const client = fakeClient({});
        const build = { actorFullName: 'owner/a', buildId: 'b1', actorRawId: 'raw1', buildNumber: '0.99.1' };
        expect(await withActorRawIds([build], client)).toEqual([build]);
        expect(client.actor).not.toHaveBeenCalled();
    });

    it('fails for an Actor the token cannot see, instead of skipping its tests', async () => {
        const client = fakeClient({});
        await expect(withActorRawIds([{ actorFullName: 'owner/missing' }], client)).rejects.toThrow(
            'Actor owner/missing not found',
        );
    });
});
