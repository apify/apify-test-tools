import { describe, expect, it } from 'vitest';

import { LEGACY_PARSER } from '../../../../../../bin/utils/config/structures/legacy.js';

const entry = (fields: Record<string, unknown> = {}) => ({
    folder: 'actors/shopify',
    actorFullName: 'myteam/shopify',
    tokenEnvVar: 'APIFY_TOKEN',
    ...fields,
});

describe('LEGACY_PARSER', () => {
    it("returns the entries as written — normalizing is not this layer's job", () => {
        const raw = entry({ folder: 'actors/shopify/', overrideActorContext: ['packages/'] });

        expect(LEGACY_PARSER.parse({ actors: [raw] })).toEqual([raw]);
    });

    it('drops the "mode" discriminator rather than choking on it', () => {
        expect(LEGACY_PARSER.parse({ mode: 'legacy', actors: [entry()] })).toEqual([entry()]);
    });

    it('rejects a file with no "actors" array', () => {
        expect(() => LEGACY_PARSER.parse({ notActors: [] })).toThrow(/expected array[\s\S]*at actors/);
    });

    it('rejects an empty "actors" array', () => {
        expect(() => LEGACY_PARSER.parse({ actors: [] })).toThrow(/Too small/);
    });

    it.each([
        ['folder is missing', { folder: undefined }, /at actors\[0\]\.folder/],
        ['folder is not a string', { folder: 123 }, /at actors\[0\]\.folder/],
        ['tokenEnvVar is missing', { tokenEnvVar: undefined }, /at actors\[0\]\.tokenEnvVar/],
        ['overrideActorContext is not an array', { overrideActorContext: 'packages' }, /expected array/],
        ['overrideActorContext holds non-strings', { overrideActorContext: [123] }, /overrideActorContext\[0\]/],
    ])('rejects an entry where %s', (_name, fields, expected) => {
        expect(() => LEGACY_PARSER.parse({ actors: [entry(fields)] })).toThrow(expected);
    });

    // The "owner/name" halves are checked against the platform's own username/actor-name rules.
    it.each([
        ['no slash', 'shopify-scraper'],
        ['an empty owner', '/shopify'],
        ['an empty name', 'myteam/'],
        ['an uppercase owner', 'MyTeam/shopify'],
        ['more than two halves', 'myteam/shopify/extra'],
    ])('rejects an actorFullName with %s', (_name, actorFullName) => {
        expect(() => LEGACY_PARSER.parse({ actors: [entry({ actorFullName })] })).toThrow(
            /at actors\[0\]\.actorFullName/,
        );
    });

    it.each([['myteam/shopify'], ['my.team/web-scraper'], ['my_team/a1'], ['apify/web-scraper']])(
        'accepts the actorFullName %s',
        (actorFullName) => {
            expect(() => LEGACY_PARSER.parse({ actors: [entry({ actorFullName })] })).not.toThrow();
        },
    );

    it('reports every invalid field at once instead of only the first', () => {
        const message = (() => {
            try {
                LEGACY_PARSER.parse({
                    actors: [{ folder: 123, actorFullName: 'shopify', overrideActorContext: 'nope' }],
                });
                throw new Error('Function should have thrown');
            } catch (err) {
                return (err as Error).message;
            }
        })();

        expect(message).toContain('actors[0].folder');
        expect(message).toContain('actors[0].actorFullName');
        expect(message).toContain('actors[0].tokenEnvVar');
        expect(message).toContain('actors[0].overrideActorContext');
    });
});
