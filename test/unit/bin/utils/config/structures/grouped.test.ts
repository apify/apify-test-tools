import { describe, expect, it } from 'vitest';

import { GROUPED_PARSER } from '../../../../../../bin/utils/config/structures/grouped.js';

const actor = (fields: Record<string, unknown> = {}) => ({
    folder: 'actors/shopify',
    actorFullName: 'myteam/shopify',
    ...fields,
});

const group = (fields: Record<string, unknown> = {}) => ({
    actors: [actor()],
    buildTokenEnvVar: 'APIFY_TOKEN',
    ...fields,
});

describe('GROUPED_PARSER', () => {
    it('flattens every group into one list, handing each actor its group’s settings', () => {
        expect(
            GROUPED_PARSER.parse({
                groups: {
                    myteam: {
                        actors: [actor(), actor({ folder: 'actors/email', actorFullName: 'myteam/email' })],
                        buildTokenEnvVar: 'APIFY_TOKEN_MYTEAM',
                        overrideActorContext: ['packages'],
                    },
                    other: {
                        actors: [actor({ folder: 'actors/x', actorFullName: 'other/x' })],
                        buildTokenEnvVar: 'TOKEN',
                    },
                },
            }),
        ).toEqual([
            {
                folder: 'actors/shopify',
                actorFullName: 'myteam/shopify',
                buildTokenEnvVar: 'APIFY_TOKEN_MYTEAM',
                overrideActorContext: ['packages'],
            },
            {
                folder: 'actors/email',
                actorFullName: 'myteam/email',
                buildTokenEnvVar: 'APIFY_TOKEN_MYTEAM',
                overrideActorContext: ['packages'],
            },
            {
                folder: 'actors/x',
                actorFullName: 'other/x',
                buildTokenEnvVar: 'TOKEN',
                overrideActorContext: undefined,
            },
        ]);
    });

    it('ignores the group key entirely', () => {
        expect(GROUPED_PARSER.parse({ groups: { 'not-a-folder-at-all': group() } })).toEqual([
            {
                folder: 'actors/shopify',
                actorFullName: 'myteam/shopify',
                buildTokenEnvVar: 'APIFY_TOKEN',
            },
        ]);
    });

    it('allows actors to override some fields', () => {
        expect(
            GROUPED_PARSER.parse({
                groups: { myteam: group({ actors: [actor({ buildTokenEnvVar: 'FROM_ACTOR' })] }) },
            }),
        ).toEqual([
            {
                folder: 'actors/shopify',
                actorFullName: 'myteam/shopify',
                buildTokenEnvVar: 'FROM_ACTOR',
            },
        ]);
    });

    it.each([
        // The default to the build token comes after the modes, see parser.test.ts
        ['leaves it unset without one', {}, {}, undefined],
        [
            'leaves it unset when the Actor sets only its own build token',
            {},
            { buildTokenEnvVar: 'FROM_ACTOR' },
            undefined,
        ],
        ['takes the group test token', { testTokenEnvVar: 'TESTER' }, {}, 'TESTER'],
        [
            "takes the group test token over the Actor's own build token",
            { testTokenEnvVar: 'TESTER' },
            { buildTokenEnvVar: 'FROM_ACTOR' },
            'TESTER',
        ],
        [
            "takes the Actor's test token over the group's",
            { testTokenEnvVar: 'TESTER' },
            { testTokenEnvVar: 'ACTOR_TESTER' },
            'ACTOR_TESTER',
        ],
    ])('inherits the test token: %s', (_name, groupFields, actorFields, expected) => {
        const [parsed] = GROUPED_PARSER.parse({
            groups: { myteam: group({ ...groupFields, actors: [actor(actorFields)] }) },
        });
        expect(parsed.testTokenEnvVar).toBe(expected);
    });

    it("returns the entries as written — normalizing is not this layer's job", () => {
        const raw = actor({ folder: 'actors/shopify/' });

        expect(
            GROUPED_PARSER.parse({ groups: { myteam: group({ actors: [raw], overrideActorContext: ['packages/'] }) } }),
        ).toEqual([{ ...raw, buildTokenEnvVar: 'APIFY_TOKEN', overrideActorContext: ['packages/'] }]);
    });

    it('rejects a config with no groups (and thus no actors)', () => {
        expect(() => GROUPED_PARSER.parse({})).toThrow();
    });

    it('rejects an empty group token name', () => {
        expect(() => GROUPED_PARSER.parse({ groups: { myteam: group({ buildTokenEnvVar: '' }) } })).toThrow(
            /at groups\.myteam\.buildTokenEnvVar/,
        );
    });

    it('rejects an empty actor token override instead of falling back to the group token', () => {
        expect(() =>
            GROUPED_PARSER.parse({ groups: { myteam: group({ actors: [actor({ buildTokenEnvVar: '' })] }) } }),
        ).toThrow(/at groups\.myteam\.actors\[0\]\.buildTokenEnvVar/);
    });

    it('rejects the tokenEnvVar of a group, naming its new name', () => {
        const { buildTokenEnvVar: _, ...oldGroup } = group({ tokenEnvVar: 'APIFY_TOKEN' });
        expect(() => GROUPED_PARSER.parse({ groups: { myteam: oldGroup } })).toThrow(
            /tokenEnvVar is renamed to buildTokenEnvVar\s+→ at groups\.myteam\.tokenEnvVar/,
        );
    });

    // Without the check, the Actor would be built with its group's token instead of its own
    it('rejects the tokenEnvVar of an Actor instead of dropping it', () => {
        expect(() =>
            GROUPED_PARSER.parse({
                groups: { myteam: group({ actors: [actor({ tokenEnvVar: 'APIFY_TOKEN_OWN' })] }) },
            }),
        ).toThrow(/tokenEnvVar is renamed to buildTokenEnvVar\s+→ at groups\.myteam\.actors\[0\]\.tokenEnvVar/);
    });

    it('reports problems from every group at once instead of only the first', () => {
        const message = (() => {
            try {
                GROUPED_PARSER.parse({
                    groups: {
                        myteam: { actors: [actor({ folder: 123 })], buildTokenEnvVar: 'APIFY_TOKEN' },
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
        expect(message).toContain('other.buildTokenEnvVar');
    });
});
