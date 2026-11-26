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
    testTokenEnvVar: 'APIFY_TOKEN_TESTER',
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
                        testTokenEnvVar: 'TESTER_MYTEAM',
                        overrideActorContext: ['packages'],
                    },
                    other: {
                        actors: [actor({ folder: 'actors/x', actorFullName: 'other/x' })],
                        buildTokenEnvVar: 'TOKEN',
                        testTokenEnvVar: 'TESTER',
                    },
                },
            }),
        ).toEqual([
            {
                folder: 'actors/shopify',
                actorFullName: 'myteam/shopify',
                buildTokenEnvVar: 'APIFY_TOKEN_MYTEAM',
                testTokenEnvVar: 'TESTER_MYTEAM',
                overrideActorContext: ['packages'],
            },
            {
                folder: 'actors/email',
                actorFullName: 'myteam/email',
                buildTokenEnvVar: 'APIFY_TOKEN_MYTEAM',
                testTokenEnvVar: 'TESTER_MYTEAM',
                overrideActorContext: ['packages'],
            },
            {
                folder: 'actors/x',
                actorFullName: 'other/x',
                buildTokenEnvVar: 'TOKEN',
                testTokenEnvVar: 'TESTER',
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
                testTokenEnvVar: 'APIFY_TOKEN_TESTER',
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
                testTokenEnvVar: 'APIFY_TOKEN_TESTER',
            },
        ]);
    });

    it.each([
        ['takes the group test token', {}, 'APIFY_TOKEN_TESTER'],
        [
            "takes the group test token, not the Actor's own build token",
            { buildTokenEnvVar: 'FROM_ACTOR' },
            'APIFY_TOKEN_TESTER',
        ],
        ["takes the Actor's test token over the group's", { testTokenEnvVar: 'ACTOR_TESTER' }, 'ACTOR_TESTER'],
    ])('inherits the test token: %s', (_name, actorFields, expected) => {
        const [parsed] = GROUPED_PARSER.parse({ groups: { myteam: group({ actors: [actor(actorFields)] }) } });
        expect(parsed.testTokenEnvVar).toBe(expected);
    });

    it.each(['buildTokenEnvVar', 'testTokenEnvVar'] as const)(
        'rejects a group without %s, pointing to the permissions',
        (field) => {
            const { [field]: _, ...body } = group();
            expect(() => GROUPED_PARSER.parse({ groups: { myteam: body } })).toThrow(
                new RegExp(
                    `${field} is required\\. See the token permissions in the README.*\\n\\s+→ at groups\\.myteam\\.${field}`,
                ),
            );
        },
    );

    it("returns the entries as written — normalizing is not this layer's job", () => {
        const raw = actor({ folder: 'actors/shopify/' });

        expect(
            GROUPED_PARSER.parse({ groups: { myteam: group({ actors: [raw], overrideActorContext: ['packages/'] }) } }),
        ).toEqual([
            {
                ...raw,
                buildTokenEnvVar: 'APIFY_TOKEN',
                testTokenEnvVar: 'APIFY_TOKEN_TESTER',
                overrideActorContext: ['packages/'],
            },
        ]);
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
                        myteam: {
                            actors: [actor({ folder: 123 })],
                            buildTokenEnvVar: 'APIFY_TOKEN',
                            testTokenEnvVar: 'APIFY_TOKEN_TESTER',
                        },
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
