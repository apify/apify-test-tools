import { describe, expect, it } from 'vitest';

import { _privates, parseConfigFile } from '../../../../../bin/utils/config/parser.js';
import { CONFIG_FILE_STRATEGY } from '../../../../../bin/utils/config/structures/base.js';
import { LEGACY_PARSER } from '../../../../../bin/utils/config/structures/legacy.js';

const { selectStrategy, verifyConfiguration } = _privates;

const actor = (fields: Record<string, unknown> = {}) => ({
    folder: 'actors/shopify',
    actorFullName: 'myteam/shopify',
    tokenEnvVar: 'APIFY_TOKEN',
    ...fields,
});

describe('selectStrategy', () => {
    it('falls back to the legacy strategy when no mode is declared', () => {
        expect(selectStrategy({ actors: [] })).toBe(LEGACY_PARSER);
    });

    it('honours an explicit mode', () => {
        expect(selectStrategy({ mode: CONFIG_FILE_STRATEGY.LEGACY, actors: [] })).toBe(LEGACY_PARSER);
    });

    it('throws on a mode no strategy is registered for', () => {
        expect(() => selectStrategy({ mode: 'brand-new' })).toThrow(/at mode/);
    });
});

describe('verifyConfiguration', () => {
    it('resolves the repo root to "" and gets rid of trailing slashes', () => {
        const result = verifyConfiguration([
            { folder: '.', actorFullName: 'myteam/root', tokenEnvVar: 'APIFY_TOKEN' },
            {
                folder: 'actors/shopify/',
                actorFullName: 'myteam/shopify',
                tokenEnvVar: 'APIFY_TOKEN',
                overrideActorContext: ['packages/'],
            },
        ]);

        expect(result).toEqual([
            { folder: '', actorFullName: 'myteam/root', tokenEnvVar: 'APIFY_TOKEN', overrideActorContext: undefined },
            {
                folder: 'actors/shopify',
                actorFullName: 'myteam/shopify',
                tokenEnvVar: 'APIFY_TOKEN',
                overrideActorContext: ['packages'],
            },
        ]);
    });

    it.each([
        ['"." and ""', '.', ''],
        ['weird roots', '', './//'],
        ['a trailing slash', 'actors/shopify', 'actors/shopify/'],
    ])('rejects folders that collide once normalized: %s', (_name, first, second) => {
        expect(() =>
            verifyConfiguration([
                actor({ folder: first, actorFullName: 'myteam/actor-a' }),
                actor({ folder: second, actorFullName: 'myteam/actor-b' }),
            ]),
        ).toThrow(/Duplicate folder/);
    });

    it('quotes a duplicate folder the way it was written, not the way it normalized', () => {
        expect(() =>
            verifyConfiguration([
                actor({ folder: '.', actorFullName: 'myteam/actor-a' }),
                actor({ folder: './', actorFullName: 'myteam/actor-b' }),
            ]),
        ).toThrow('Duplicate folder "./"');
    });

    it('rejects two entries pointing at the same actor', () => {
        expect(() => verifyConfiguration([actor({ folder: 'actors/a' }), actor({ folder: 'actors/b' })])).toThrow(
            /Duplicate actor "myteam\/shopify"/,
        );
    });

    it('treats actorFullName case-sensitively — "myteam/A" is not "myteam/a"', () => {
        expect(() =>
            verifyConfiguration([
                actor({ folder: 'actors/a', actorFullName: 'myteam/abc' }),
                actor({ folder: 'actors/b', actorFullName: 'myteam/ABC' }),
            ]),
        ).not.toThrow();
    });

    it('reports every collision at once instead of stopping at the first', () => {
        const message = (() => {
            try {
                verifyConfiguration([
                    actor({ folder: 'actors/a', actorFullName: 'myteam/actor-a' }),
                    actor({ folder: 'actors/a', actorFullName: 'myteam/actor-b' }),
                    actor({ folder: 'actors/c', actorFullName: 'myteam/actor-c' }),
                    actor({ folder: 'actors/d', actorFullName: 'myteam/actor-c' }),
                ]);
                return '';
            } catch (err) {
                return (err as Error).message;
            }
        })();

        expect(message.split('\n')).toEqual([
            'Duplicate folder "actors/a". Each actor must have a unique folder.',
            'Duplicate actor "myteam/actor-c". Each entry must point at a different actor.',
        ]);
    });

    it('reports both problems for an entry that duplicates a folder and an actor at once', () => {
        expect(() => verifyConfiguration([actor(), actor()])).toThrow(/Duplicate folder[\s\S]*Duplicate actor/);
    });

    it('accepts an empty configuration', () => {
        expect(verifyConfiguration([])).toEqual([]);
    });
});

// The seam that matters: a differently shaped config file only has to reach this function's output
// to work with everything downstream.
describe('parseConfigFile', () => {
    it('validates and normalizes a plain object without touching the filesystem', () => {
        expect(parseConfigFile({ actors: [actor({ folder: 'actors/shopify/' })] })).toEqual([
            actor({ folder: 'actors/shopify', overrideActorContext: undefined }),
        ]);
    });

    it('surfaces schema violations from the selected strategy', () => {
        expect(() => parseConfigFile({ actors: [actor({ folder: 123 })] })).toThrow(/at actors\[0\]\.folder/);
    });

    it('surfaces cross-entry violations the schema cannot see', () => {
        expect(() => parseConfigFile({ actors: [actor({ actorFullName: 'myteam/actor-a' }), actor()] })).toThrow(
            /Duplicate folder/,
        );
    });
});
