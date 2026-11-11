import { describe, expect, it } from 'vitest';

import { isActorFullName, isActorRawId } from '../../lib/actor-ids.js';

describe('Actor ID formats', () => {
    it.each(['apify/web-scraper', 'my.team/a1', 'MyTeam/shopify'])('takes %s as a full name', (actorId) => {
        expect(isActorFullName(actorId)).toBe(true);
        expect(isActorRawId(actorId)).toBe(false);
    });

    it('takes 17 letters and digits as a raw ID', () => {
        expect(isActorRawId('rawIdOfOwnerA0000')).toBe(true);
        expect(isActorFullName('rawIdOfOwnerA0000')).toBe(false);
    });

    it.each(['raw1', 'rawIdOfOwnerA00000', 'not an id', 'owner/', '/name', 'a/b/c', ''])(
        'takes %j as neither',
        (actorId) => {
            expect(isActorFullName(actorId)).toBe(false);
            expect(isActorRawId(actorId)).toBe(false);
        },
    );
});
