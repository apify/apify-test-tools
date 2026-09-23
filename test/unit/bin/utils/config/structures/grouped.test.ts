import { describe, expect, it } from 'vitest';

import { GROUPED_PARSER } from '../../../../../../bin/utils/config/structures/grouped.js';

const actor = (fields: Record<string, unknown> = {}) => ({
    folder: 'actors/shopify',
    actorFullName: 'myteam/shopify',
    ...fields,
});

const group = (fields: Record<string, unknown> = {}) => ({
    actors: [actor()],
    tokenEnvVar: 'APIFY_TOKEN',
    ...fields,
});

describe('GROUPED_PARSER', () => {
    it('flattens every group into one list, handing each actor its group’s settings', () => {
        expect(
            GROUPED_PARSER.parse({
                groups: {
                    myteam: {
                        actors: [actor(), actor({ folder: 'actors/email', actorFullName: 'myteam/email' })],
                        tokenEnvVar: 'APIFY_TOKEN_MYTEAM',
                        overrideActorContext: ['packages'],
                    },
                    other: { actors: [actor({ folder: 'actors/x', actorFullName: 'other/x' })], tokenEnvVar: 'TOKEN' },
                },
            }),
        ).toEqual([
            {
                folder: 'actors/shopify',
                actorFullName: 'myteam/shopify',
                tokenEnvVar: 'APIFY_TOKEN_MYTEAM',
                overrideActorContext: ['packages'],
            },
            {
                folder: 'actors/email',
                actorFullName: 'myteam/email',
                tokenEnvVar: 'APIFY_TOKEN_MYTEAM',
                overrideActorContext: ['packages'],
            },
            { folder: 'actors/x', actorFullName: 'other/x', tokenEnvVar: 'TOKEN', overrideActorContext: undefined },
        ]);
    });

    it('ignores the group key entirely', () => {
        expect(GROUPED_PARSER.parse({ groups: { 'not-a-folder-at-all': group() } })).toEqual([
            { folder: 'actors/shopify', actorFullName: 'myteam/shopify', tokenEnvVar: 'APIFY_TOKEN' },
        ]);
    });

    it('allows actors to override some fields', () => {
        expect(
            GROUPED_PARSER.parse({ groups: { myteam: group({ actors: [actor({ tokenEnvVar: 'FROM_ACTOR' })] }) } }),
        ).toEqual([{ folder: 'actors/shopify', actorFullName: 'myteam/shopify', tokenEnvVar: 'FROM_ACTOR' }]);
    });

    it("returns the entries as written — normalizing is not this layer's job", () => {
        const raw = actor({ folder: 'actors/shopify/' });

        expect(
            GROUPED_PARSER.parse({ groups: { myteam: group({ actors: [raw], overrideActorContext: ['packages/'] }) } }),
        ).toEqual([{ ...raw, tokenEnvVar: 'APIFY_TOKEN', overrideActorContext: ['packages/'] }]);
    });

    it('rejects a config with no groups (and thus no actors)', () => {
        expect(() => GROUPED_PARSER.parse({})).toThrow();
    });

    it('reports problems from every group at once instead of only the first', () => {
        const message = (() => {
            try {
                GROUPED_PARSER.parse({
                    groups: {
                        myteam: { actors: [actor({ folder: 123 })], tokenEnvVar: 'APIFY_TOKEN' },
                        other: { actors: [actor({ actorFullName: 'nope' })] },
                    },
                });
                throw new Error('Function should have thrown');
            } catch (err) {
                return (err as Error).message;
            }
        })();

        expect(message).toContain('myteam.actors[0].folder');
        expect(message).toContain('other.actors[0].actorFullName');
        expect(message).toContain('other.tokenEnvVar');
    });
});
