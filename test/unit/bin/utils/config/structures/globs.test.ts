import { describe, expect, it } from 'vitest';

import { GLOBS_PARSER } from '../../../../../../bin/utils/config/structures/globs.js';

const actor = (fields: Record<string, unknown> = {}) => ({
    folder: 'actors/shopify',
    actorFullName: 'myteam/shopify',
    ...fields,
});

const config = (fields: Record<string, unknown> = {}) => ({
    match: { folderGlob: 'actors/*' },
    set: { tokenEnvVar: 'APIFY_TOKEN' },
    ...fields,
});

const errorMessage = (body: Record<string, unknown>) => {
    try {
        GLOBS_PARSER.parse(body);
        throw new Error('Function should have thrown');
    } catch (err) {
        return (err as Error).message;
    }
};

describe('GLOBS_PARSER', () => {
    it('applies the settings of every matching config, leaving other actors untouched', () => {
        expect(
            GLOBS_PARSER.parse({
                actors: [actor(), actor({ folder: 'other/email', actorFullName: 'other/email', tokenEnvVar: 'TOKEN' })],
                configs: [config(), config({ set: { overrideActorContext: ['packages'] } })],
            }),
        ).toEqual([
            {
                folder: 'actors/shopify',
                actorFullName: 'myteam/shopify',
                tokenEnvVar: 'APIFY_TOKEN',
                overrideActorContext: ['packages'],
            },
            { folder: 'other/email', actorFullName: 'other/email', tokenEnvVar: 'TOKEN' },
        ]);
    });

    it('requires both globs to match if both are specified', () => {
        expect(
            GLOBS_PARSER.parse({
                actors: [
                    actor({ tokenEnvVar: 'TOKEN' }),
                    actor({ folder: 'actors/email', actorFullName: 'other/email' }),
                ],
                configs: [config({ match: { folderGlob: 'actors/*', actorFullNameGlob: 'other/*' } })],
            }),
        ).toEqual([
            { folder: 'actors/shopify', actorFullName: 'myteam/shopify', tokenEnvVar: 'TOKEN' },
            { folder: 'actors/email', actorFullName: 'other/email', tokenEnvVar: 'APIFY_TOKEN' },
        ]);
    });

    it('rejects two configs setting the same key, even to the same value', () => {
        expect(errorMessage({ actors: [actor()], configs: [config(), config(), config()] }).split('\n')).toEqual([
            'Actor "myteam/shopify": "tokenEnvVar" is set by both configs[0] and configs[1].',
            'Actor "myteam/shopify": "tokenEnvVar" is set by both configs[0] and configs[2].',
        ]);
    });

    it('rejects a config setting a key the actor already defines', () => {
        expect(() =>
            GLOBS_PARSER.parse({ actors: [actor({ tokenEnvVar: 'APIFY_TOKEN' })], configs: [config()] }),
        ).toThrow('Actor "myteam/shopify": "tokenEnvVar" is set on the actor and by configs[0].');
    });

    it('rejects an actor left without a tokenEnvVar', () => {
        expect(() =>
            GLOBS_PARSER.parse({ actors: [actor()], configs: [config({ set: { overrideActorContext: ['shared'] } })] }),
        ).toThrow('Actor "myteam/shopify" has no tokenEnvVar: set it on the actor or through a matching config.');
    });

    it('reports problems from every actor at once instead of only the first', () => {
        expect(
            errorMessage({
                actors: [
                    actor({ overrideActorContext: ['packages'] }),
                    actor({ folder: 'other/email', actorFullName: 'other/email' }),
                ],
                configs: [config({ set: { tokenEnvVar: 'APIFY_TOKEN', overrideActorContext: ['packages'] } })],
            }).split('\n'),
        ).toEqual([
            'Actor "myteam/shopify": "overrideActorContext" is set on the actor and by configs[0].',
            'Actor "other/email" has no tokenEnvVar: set it on the actor or through a matching config.',
        ]);
    });

    it.each([
        ['match', { match: {} }],
        ['set', { set: {} }],
    ])('rejects a config with an empty %s', (_name, fields) => {
        expect(() => GLOBS_PARSER.parse({ actors: [actor()], configs: [config(fields)] })).toThrow();
    });
});
