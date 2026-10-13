import { describe, expect, it } from 'vitest';

import { parseBuildInput } from '../../../bin/build-input.js';

describe('parseBuildInput', () => {
    it('reads the Actors and the branch', () => {
        expect(parseBuildInput('{"ref":"feature","actors":[{"actorFullName":"owner/a"}]}')).toStrictEqual({
            ref: 'feature',
            actors: [{ actorFullName: 'owner/a' }],
        });
    });

    it('takes a picked get-affected-actors document, ignoring the other fields', () => {
        const picked = { ref: null, head: 'f'.repeat(40), actors: [{ actorFullName: 'owner/a', extra: 1 }] };
        expect(parseBuildInput(JSON.stringify(picked))).toStrictEqual({
            ref: null,
            actors: [{ actorFullName: 'owner/a' }],
        });
    });

    it('accepts an empty list, which builds nothing', () => {
        expect(parseBuildInput('{"actors":[]}')).toStrictEqual({ actors: [] });
    });

    it('rejects empty input, which is what a failed command earlier in a pipe leaves behind', () => {
        expect(() => parseBuildInput('  \n')).toThrow('got nothing');
    });

    it('rejects input that is not JSON', () => {
        expect(() => parseBuildInput('owner/a')).toThrow('not valid JSON');
    });

    it('rejects JSON that is not a list of Actors, e.g. a whole get-affected-actors document', () => {
        expect(() => parseBuildInput('{"functionallyChangedActors":[{"actorFullName":"owner/a"}]}')).toThrow(
            'not a list of Actors to build',
        );
    });
});
