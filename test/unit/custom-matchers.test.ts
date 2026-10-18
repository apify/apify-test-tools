import { describe, expect, it } from 'vitest';

import { extendExpect } from '../../lib/extend-expect.js';
import type { RunTestResult } from '../../lib/run-test-result.js';

extendExpect(expect);

describe('custom matchers', () => {
    it.each([
        ['toBeArray', [[], [1]], [{}, 'a', null]],
        ['toBeBoolean', [true, false], [0, 'true', null]],
        ['toBeEmptyArray', [[]], [[1], {}, undefined]],
        ['toBeNonEmptyArray', [[1]], [[], {}, 'a']],
        ['toBeNonEmptyString', ['a'], ['', 1, null]],
        ['toBeNumber', [0, 1.5], ['1', null]],
        ['toBeNonEmptyObject', [{ a: 1 }], [{}, [1], null, undefined]],
        ['toBeObject', [{}, { a: 1 }], [[], null, undefined, 'a']],
        ['toBeString', ['', 'a'], [1, null]],
        ['toBeTrue', [true], [1, 'true', false]],
        ['toBeFalse', [false], [0, '', true]],
        ['toBeWholeNumber', [0, 3], [1.5, '3', null]],
    ] as const)('%s', (matcher, passing, failing) => {
        for (const value of passing) expect(value)[matcher]();
        for (const value of failing) {
            expect(() => expect(value)[matcher]()).toThrow();
            expect(value).not[matcher]();
        }
    });

    it('toBeWithinRange', () => {
        expect(5).toBeWithinRange(1, 5);
        expect(() => expect(6).toBeWithinRange(1, 5)).toThrow('to be within range <1, 5>');
    });

    it('toStartWith', () => {
        expect('prefix-and-more').toStartWith('prefix');
        expect(() => expect('other').toStartWith('prefix')).toThrow();
    });

    it('describes the failing value in the message', () => {
        expect(() => expect({ a: 1 }).toBeString()).toThrow('Expected {"a":1} to be a string');
    });

    describe('toFinishWith', () => {
        const run = {
            status: 'FAILED',
            getRunInfo: async () => ({ stats: { durationMillis: 5000 } }),
            getDatasetItemCount: async () => 3,
            getStatistics: async () => ({ requestsFailed: 0, requestsRetries: 0 }),
            getLog: async () => '',
        } as unknown as RunTestResult;

        it('passes when every check passes', async () => {
            await expect({ ...run, status: 'SUCCEEDED' }).toFinishWith({ datasetItemCount: 3 });
        });

        it('fails with every failed assertion in the message', async () => {
            await expect(expect(run).toFinishWith({ datasetItemCount: { min: 5 } })).rejects.toThrow(
                /Failed status check, expected "SUCCEEDED", got "FAILED"\. Failed dataset item count check/,
            );
        });
    });
});
