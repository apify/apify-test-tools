import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkRun } from '../../lib/run-checks.js';
import type { RunTestResult } from '../../lib/run-test-result.js';

const fakeRun = (overrides: { status?: string; log?: string; stats?: object; chargedEventCounts?: object } = {}) => {
    const getRunInfo = async () => ({
        stats: { durationMillis: 5_000 },
        chargedEventCounts: overrides.chargedEventCounts,
    });
    return {
        status: overrides.status ?? 'SUCCEEDED',
        getRunInfo,
        fetchRunInfo: getRunInfo,
        getDataset: async () => ({ items: new Array(10) }),
        getStatistics: async () => ({
            requestsFailed: 0,
            requestsRetries: 1,
            requestRetryHistogram: [5, 1],
            ...overrides.stats,
        }),
        getLog: async () => overrides.log ?? 'all good',
    } as unknown as RunTestResult;
};

const failures = async (run: RunTestResult, options: Parameters<typeof checkRun>[1]) =>
    (await checkRun(run, options)).filter(({ pass }) => !pass).map(({ name }) => name);

describe('checkRun()', () => {
    it('passes a run matching the defaults', async () => {
        expect(await failures(fakeRun(), { datasetItemCount: 10 })).toEqual([]);
    });

    it('reports every failing check at once', async () => {
        const run = fakeRun({ status: 'FAILED', log: 'TypeError: x', stats: { requestsFailed: 2 } });
        expect(await failures(run, { datasetItemCount: { min: 11 } })).toEqual([
            'status',
            'datasetItemCount',
            'failedRequests',
            'forbiddenLogs',
        ]);
    });

    it('disables a check with null', async () => {
        const run = fakeRun({ stats: { requestsFailed: 2 } });
        expect(await failures(run, { datasetItemCount: 10, failedRequests: null })).toEqual([]);
    });

    it('treats explicitly undefined options as disabled checks', async () => {
        const options = { datasetItemCount: 10, duration: undefined, maxRetriesPerRequest: undefined };
        expect(await failures(fakeRun(), options)).toEqual([]);
    });

    it('checks the longest retry chain only when asked to', async () => {
        expect(await failures(fakeRun(), { datasetItemCount: 10, maxRetriesPerRequest: 0 })).toEqual([
            'maxRetriesPerRequest',
        ]);
        expect(await failures(fakeRun(), { datasetItemCount: 10, maxRetriesPerRequest: 1 })).toEqual([]);
    });

    describe('chargedEventCounts', () => {
        const chargedRun = fakeRun({ chargedEventCounts: { start: 1, item: 7 } });

        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        const settled = async <T>(result: Promise<T>): Promise<T> => {
            await vi.runAllTimersAsync();
            return result;
        };

        it('passes matching counts and intervals', async () => {
            const options = { datasetItemCount: 10, chargedEventCounts: { start: 1, item: { min: 5 } } };
            expect(await failures(chargedRun, options)).toEqual([]);
        });

        it('expects unlisted charged events to not happen', async () => {
            const options = { datasetItemCount: 10, chargedEventCounts: { start: 1 } as Record<string, number> };
            expect(await failures(chargedRun, options)).toEqual(['chargedEventCounts.item']);
        });

        it('fails an expected event that was never charged', async () => {
            const options = { datasetItemCount: 10, chargedEventCounts: { start: 1, item: 7, extra: { min: 0 } } };
            expect(await settled(failures(chargedRun, options))).toEqual(['chargedEventCounts.extra']);
        });

        describe('waiting for the counts to reach the run', () => {
            const options = { datasetItemCount: 10, chargedEventCounts: { start: 1, item: { min: 5 } } };
            const laggingRun = (...fetched: object[]) => {
                const fetchRunInfo = vi.fn(async () => ({
                    stats: { durationMillis: 5_000 },
                    chargedEventCounts: fetched.shift(),
                }));
                return { ...fakeRun(), getRunInfo: fetchRunInfo, fetchRunInfo };
            };

            it('re-fetches the run until the expected counts show up', async () => {
                const run = laggingRun({}, { start: 1 }, { start: 1, item: 7 }, { start: 1, item: 99 });
                expect(await settled(failures(run as unknown as RunTestResult, options))).toEqual([]);
                expect(run.fetchRunInfo).toHaveBeenCalledTimes(3);
            });

            it('gives up after a minute and reports the last counts', async () => {
                const run = laggingRun();
                const result = checkRun(run as unknown as RunTestResult, options);
                await vi.advanceTimersByTimeAsync(59_999);
                expect(run.fetchRunInfo).toHaveBeenCalledTimes(12);
                await vi.advanceTimersByTimeAsync(1);
                expect(run.fetchRunInfo).toHaveBeenCalledTimes(13);
                expect((await result).filter(({ pass }) => !pass)).toEqual([
                    { name: 'chargedEventCounts.start', pass: false, actual: 'X', expected: '1' },
                    { name: 'chargedEventCounts.item', pass: false, actual: 'X', expected: '<5,>' },
                ]);
            });

            it('stops waiting once a count is past its maximum', async () => {
                const run = laggingRun({ start: 2 }, { start: 1, item: 7 });
                const result = await settled(failures(run as unknown as RunTestResult, options));
                expect(result).toEqual(['chargedEventCounts.start', 'chargedEventCounts.item']);
                expect(run.fetchRunInfo).toHaveBeenCalledTimes(1);
            });

            it('fetches the run once without chargedEventCounts expectations', async () => {
                const run = laggingRun();
                expect(await failures(run as unknown as RunTestResult, { datasetItemCount: 10 })).toEqual([]);
                expect(run.fetchRunInfo).toHaveBeenCalledTimes(1);
            });
        });
    });
});
