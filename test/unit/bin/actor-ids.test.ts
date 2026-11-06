import { describe, expect, it, vi } from 'vitest';

import { withActorIds } from '../../../bin/actor-ids.js';

type Client = NonNullable<Parameters<typeof withActorIds>[1]>;

/** A client that knows one Actor, by its full name and by its raw ID, as the API does */
const fakeClient = () => {
    const known = { id: 'rawA', username: 'owner', name: 'a' };
    const actor = vi.fn((actorId: string) => ({
        get: async () => (actorId === 'owner/a' || actorId === 'rawA' ? known : undefined),
    }));
    return { actor } as unknown as Client & { actor: typeof actor };
};

describe('withActorIds', () => {
    it('adds the raw ID to an Actor listed by full name, as get-actor-configs lists them', async () => {
        expect(await withActorIds([{ actorFullName: 'owner/a' }], fakeClient())).toEqual([
            { actorFullName: 'owner/a', actorRawId: 'rawA' },
        ]);
    });

    it('adds the full name to an Actor listed by raw ID', async () => {
        const build = { actorRawId: 'rawA', buildId: 'b1', buildNumber: '0.99.1' };
        expect(await withActorIds([build], fakeClient())).toEqual([{ ...build, actorFullName: 'owner/a' }]);
    });

    it('keeps the IDs of a build and does not look them up', async () => {
        const client = fakeClient();
        const build = { actorFullName: 'owner/a', buildId: 'b1', actorRawId: 'raw1', buildNumber: '0.99.1' };
        expect(await withActorIds([build], client)).toEqual([build]);
        expect(client.actor).not.toHaveBeenCalled();
    });

    it('keeps an Actor the token cannot see as listed, instead of failing the run', async () => {
        const targets = [
            { actorFullName: 'owner/missing' },
            { actorRawId: 'rawMissing' },
            { actorFullName: 'owner/a' },
        ];
        expect(await withActorIds(targets, fakeClient())).toEqual([
            { actorFullName: 'owner/missing' },
            { actorRawId: 'rawMissing' },
            { actorFullName: 'owner/a', actorRawId: 'rawA' },
        ]);
    });
});
