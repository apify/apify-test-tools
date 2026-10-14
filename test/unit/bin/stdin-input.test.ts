import { describe, expect, it } from 'vitest';

import { parseBuildInput, parseReleaseChanges } from '../../../bin/stdin-input.js';

describe('parseBuildInput', () => {
    it('reads the Actors', () => {
        expect(parseBuildInput('{"actors":[{"actorFullName":"owner/a"}]}')).toStrictEqual({
            actors: [{ actorFullName: 'owner/a' }],
        });
    });

    it('ignores the other fields, so whole get-affected-actors fields can be passed along', () => {
        const input = { head: 'f'.repeat(40), ref: 'feature', actors: [{ actorFullName: 'owner/a', extra: 1 }] };
        expect(parseBuildInput(JSON.stringify(input))).toStrictEqual({ actors: [{ actorFullName: 'owner/a' }] });
    });

    it('accepts an empty list, which builds nothing', () => {
        expect(parseBuildInput('{"actors":[]}')).toStrictEqual({ actors: [] });
    });

    it('rejects empty input, which is what a failed command earlier in a pipe leaves behind', () => {
        expect(() => parseBuildInput('  \n')).toThrow('Expected the Actors to build as JSON on stdin, got nothing');
    });

    it('rejects input that is not JSON', () => {
        expect(() => parseBuildInput('owner/a')).toThrow('not valid JSON');
    });

    it('rejects JSON that is not a list of Actors, e.g. a whole get-affected-actors document', () => {
        expect(() => parseBuildInput('{"functionallyChangedActors":[{"actorFullName":"owner/a"}]}')).toThrow(
            'is not the Actors to build',
        );
    });
});

describe('parseReleaseChanges', () => {
    const commit = { sha: '1'.repeat(40), author: 'Dev<dev@example.com>', date: 'Date', message: 'feat: foo' };

    it('reads what changed from a get-affected-actors document, ignoring the rest', () => {
        const document = {
            version: 1,
            ref: 'master',
            head: '1'.repeat(40),
            commits: [commit],
            changedFiles: ['src/main.ts'],
            changelog: '- Added foo',
            functionallyChangedActors: [{ actorFullName: 'owner/a' }],
            cosmeticallyChangedActors: [],
        };
        expect(parseReleaseChanges(JSON.stringify(document))).toStrictEqual({
            commits: [commit],
            changedFiles: ['src/main.ts'],
            changelog: '- Added foo',
        });
    });

    it('rejects empty input and input that is not a get-affected-actors document', () => {
        expect(() => parseReleaseChanges('')).toThrow('got nothing');
        expect(() => parseReleaseChanges('{"actors":[]}')).toThrow('not the output of get-affected-actors');
    });
});
