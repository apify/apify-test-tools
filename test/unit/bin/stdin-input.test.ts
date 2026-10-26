import { describe, expect, it } from 'vitest';

import { parseBuildInput, parseReleaseChanges, parseTestBuilds, parseTestReport } from '../../../bin/stdin-input.js';

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

describe('parseTestBuilds', () => {
    const build = { buildId: 'b', actorRawId: 'r', buildNumber: '0.99.1', actorFullName: 'owner/a' };

    it('reads the output of build', () => {
        expect(parseTestBuilds(JSON.stringify([build]))).toStrictEqual([build]);
        expect(parseTestBuilds('[]')).toStrictEqual([]);
    });

    it('rejects a dry-run plan, which built nothing', () => {
        expect(() => parseTestBuilds(JSON.stringify({ dryRun: true, builds: [build] }))).toThrow('is a dry-run plan');
    });

    it('rejects empty input and input that is not builds', () => {
        expect(() => parseTestBuilds('')).toThrow('Expected the builds to test as JSON on stdin, got nothing');
        expect(() => parseTestBuilds('{"actors":[]}')).toThrow('is not the builds to test');
        expect(() => parseTestBuilds('{oops')).toThrow('not valid JSON');
    });
});

describe('parseTestReport', () => {
    it('reads the output of test', () => {
        const report = {
            version: 1,
            success: true,
            summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
            tests: [],
            errors: [],
        };
        expect(parseTestReport(JSON.stringify(report))).toStrictEqual(report);
    });

    it('rejects empty input and input that is not a test report, e.g. raw vitest JSON', () => {
        expect(() => parseTestReport('')).toThrow('got nothing');
        expect(() => parseTestReport('{"success":true,"testResults":[]}')).toThrow('is not the output of test');
    });
});
