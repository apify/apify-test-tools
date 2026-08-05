import { describe, expect, it } from 'vitest';

import { selectActors } from '../../../bin/actor-filtering.js';
import type { ActorConfig } from '../../../bin/types.js';

const actor = (actorFullName: string): ActorConfig => ({
    actorFullName,
    folder: actorFullName.split('/')[1],
    tokenEnvVar: 'TOKEN',
    dockerContextDir: '.',
    contextPaths: [],
});

const configs = [actor('owner/a'), actor('owner/b'), actor('owner/c')];
const names = (result: ActorConfig[]) => result.map((c) => c.actorFullName);

describe('selectActors', () => {
    it('returns all actors when neither filter is set', () => {
        expect(names(selectActors({ actors: [], ignore: [] }, configs))).toStrictEqual([
            'owner/a',
            'owner/b',
            'owner/c',
        ]);
    });

    it('keeps only the actors listed in --actors', () => {
        expect(names(selectActors({ actors: ['owner/a', 'owner/c'], ignore: [] }, configs))).toStrictEqual([
            'owner/a',
            'owner/c',
        ]);
    });

    it('drops the actors listed in --ignore', () => {
        expect(names(selectActors({ actors: [], ignore: ['owner/b'] }, configs))).toStrictEqual(['owner/a', 'owner/c']);
    });

    it('applies --actors first, then removes --ignore from that subset', () => {
        expect(names(selectActors({ actors: ['owner/a', 'owner/b'], ignore: ['owner/b'] }, configs))).toStrictEqual([
            'owner/a',
        ]);
    });

    it('can select down to nothing when --actors and --ignore overlap fully', () => {
        expect(selectActors({ actors: ['owner/a'], ignore: ['owner/a'] }, configs)).toStrictEqual([]);
    });

    it('throws listing every unknown name across both filters', () => {
        expect(() => selectActors({ actors: ['owner/x'], ignore: ['owner/y'] }, configs)).toThrow(
            'The following actors from the filter config do not exist: owner/x, owner/y',
        );
    });
});
