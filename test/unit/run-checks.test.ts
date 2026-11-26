import type { ActorRun, ApifyClient } from 'apify-client';
import { describe, expect, it, vi } from 'vitest';

import { checkRun } from '../../lib/run-checks.js';
import { RunTestResult } from '../../lib/run-test-result.js';

const STATS = { requestsFailed: 0, requestsRetries: 1, requestRetryHistogram: [5, 1] };

interface FakeRun {
    status?: string;
    log?: string;
    durationMillis?: number;
    /** The statistics records of the run, by key. The default crawler's only, unless given. */
    statistics?: Record<string, object>;
    chargedEventCounts?: object;
}

// A real RunTestResult, so the statistics are found and summed as in a test, over a fake key-value store
const fakeRun = ({
    status = 'SUCCEEDED',
    log = 'all good',
    durationMillis = 5_000,
    statistics = { SDK_CRAWLER_STATISTICS_0: STATS },
    chargedEventCounts,
}: FakeRun = {}) => {
    const getRecord = vi.fn(async (key: string) => (key in statistics ? { key, value: statistics[key] } : undefined));
    const listKeys = vi.fn(async ({ prefix }: { prefix: string }) => ({
        items: Object.keys(statistics)
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ key })),
    }));
    const client = { keyValueStore: () => ({ getRecord, listKeys }) } as unknown as ApifyClient;
    const run = new RunTestResult(client, { id: 'run', status, defaultKeyValueStoreId: 'kvs' } as ActorRun);
    return Object.assign(run, {
        getRunInfo: async () => ({ stats: { durationMillis }, chargedEventCounts }),
        getDataset: async () => ({ items: new Array(10) }),
        getLog: async () => log,
        getRecord,
        listKeys,
    }) as RunTestResult & { getRecord: typeof getRecord; listKeys: typeof listKeys };
};

const checks = async (run: RunTestResult, options: Parameters<typeof checkRun>[1]) =>
    (await checkRun(run, options)).filter(({ pass }) => !pass);

const failures = async (run: RunTestResult, options: Parameters<typeof checkRun>[1]) =>
    (await checks(run, options)).map(({ name }) => name);

describe('checkRun()', () => {
    it('passes a run matching the defaults', async () => {
        expect(await failures(fakeRun(), { datasetItemCount: 10 })).toEqual([]);
    });

    it('reports every failing check at once', async () => {
        const run = fakeRun({
            status: 'FAILED',
            log: 'TypeError: x',
            statistics: { SDK_CRAWLER_STATISTICS_0: { ...STATS, requestsFailed: 2 } },
        });
        expect(await failures(run, { datasetItemCount: { min: 11 } })).toEqual([
            'status',
            'datasetItemCount',
            'failedRequests',
            'forbiddenLogs',
        ]);
    });

    it('disables a check with null', async () => {
        const run = fakeRun({ statistics: { SDK_CRAWLER_STATISTICS_0: { ...STATS, requestsFailed: 2 } } });
        expect(await failures(run, { datasetItemCount: 10, failedRequests: null })).toEqual([]);
    });

    it('treats explicitly undefined options as disabled checks', async () => {
        const options = { datasetItemCount: 10, failedRequests: undefined, maxRetriesPerRequest: undefined };
        expect(await failures(fakeRun(), options)).toEqual([]);
    });

    it('checks the duration and the retries only when asked to', async () => {
        const run = fakeRun({
            durationMillis: 1,
            statistics: { SDK_CRAWLER_STATISTICS_0: { ...STATS, requestsRetries: 50 } },
        });
        expect(await failures(run, { datasetItemCount: 10 })).toEqual([]);
        expect(
            await failures(run, { datasetItemCount: 10, duration: { min: 600 }, requestsRetries: { max: 3 } }),
        ).toEqual(['duration', 'requestsRetries']);
    });

    it('checks the longest retry chain only when asked to', async () => {
        expect(await failures(fakeRun(), { datasetItemCount: 10, maxRetriesPerRequest: 0 })).toEqual([
            'maxRetriesPerRequest',
        ]);
        expect(await failures(fakeRun(), { datasetItemCount: 10, maxRetriesPerRequest: 1 })).toEqual([]);
    });

    describe('statistics', () => {
        it('fails the checks that need statistics when the run has none, naming the prefixes', async () => {
            const run = fakeRun({ statistics: { OTHER_RECORD: STATS } });
            const failed = await checks(run, { datasetItemCount: 10, requestsRetries: { max: 3 } });
            const actual = 'no statistics record SDK_CRAWLER_STATISTICS_* or CRAWLEE_CRAWLER_STATISTICS_*';
            expect(failed).toEqual([
                { name: 'failedRequests', pass: false, actual, expected: '0' },
                { name: 'requestsRetries', pass: false, actual, expected: '<,3>' },
            ]);
        });

        it('sums every crawler statistics record the run has, under either prefix', async () => {
            const run = fakeRun({
                statistics: {
                    SDK_CRAWLER_STATISTICS_0: { requestsFailed: 1, requestsRetries: 2, requestRetryHistogram: [5, 2] },
                    CRAWLEE_CRAWLER_STATISTICS_0: { requestsFailed: 2, requestsRetries: 3, requestRetryHistogram: [1] },
                    SDK_CRAWLER_STATISTICS_adaptive: {
                        requestsFailed: 0,
                        requestsRetries: 1,
                        requestRetryHistogram: [5, 0, 0, 1],
                    },
                    OTHER_RECORD: { requestsFailed: 100, requestsRetries: 100, requestRetryHistogram: [] },
                },
            });
            const options = { datasetItemCount: 10, failedRequests: 3, requestsRetries: 6, maxRetriesPerRequest: 3 };
            expect(await failures(run, options)).toEqual([]);
            expect(run.getRecord.mock.calls.map(([key]) => key)).toEqual([
                'CRAWLEE_CRAWLER_STATISTICS_0',
                'SDK_CRAWLER_STATISTICS_0',
                'SDK_CRAWLER_STATISTICS_adaptive',
            ]);
        });

        it('reads no statistics when no check needs them, e.g. for an Actor without a crawler', async () => {
            const run = fakeRun({ statistics: {} });
            expect(await failures(run, { datasetItemCount: 10, failedRequests: null })).toEqual([]);
            expect(run.listKeys).not.toHaveBeenCalled();
            expect(run.getRecord).not.toHaveBeenCalled();
        });

        it('reads the record statisticsKeys names', async () => {
            const run = fakeRun({ statistics: { SDK_CRAWLER_STATISTICS_1: { ...STATS, requestsFailed: 2 } } });
            const options = { datasetItemCount: 10, statisticsKeys: 'SDK_CRAWLER_STATISTICS_1' };
            expect(await failures(run, { ...options, failedRequests: 2 })).toEqual([]);
            expect(run.getRecord).toHaveBeenCalledWith('SDK_CRAWLER_STATISTICS_1');
            expect(run.listKeys).not.toHaveBeenCalled();
        });

        it('sums the records of several crawlers', async () => {
            const run = fakeRun({
                statistics: {
                    first: { requestsFailed: 1, requestsRetries: 2, requestRetryHistogram: [5, 2] },
                    second: { requestsFailed: 2, requestsRetries: 3, requestRetryHistogram: [5, 1, 0, 1] },
                },
            });
            const options = { datasetItemCount: 10, statisticsKeys: ['first', 'second'] };
            expect(
                await failures(run, { ...options, failedRequests: 3, requestsRetries: 5, maxRetriesPerRequest: 3 }),
            ).toEqual([]);
            expect(await failures(run, { ...options, failedRequests: 2, maxRetriesPerRequest: 2 })).toEqual([
                'failedRequests',
                'maxRetriesPerRequest',
            ]);
        });

        it('fails when any of several records is missing', async () => {
            const run = fakeRun();
            const failed = await checks(run, {
                datasetItemCount: 10,
                statisticsKeys: ['SDK_CRAWLER_STATISTICS_0', 'SDK_CRAWLER_STATISTICS_1'],
            });
            expect(failed.map(({ actual }) => actual)).toEqual(['no statistics record SDK_CRAWLER_STATISTICS_1']);
        });
    });

    describe('forbiddenLogs', () => {
        it('fails on an error the way JavaScript prints it, quoting the line', async () => {
            const log =
                '2026-11-16T10:00:00.000Z ERROR Request failed\nTypeError: Cannot read properties of undefined\n';
            const failed = await checks(fakeRun({ log }), { datasetItemCount: 10 });
            expect(failed).toEqual([
                {
                    name: 'forbiddenLogs',
                    pass: false,
                    actual: '[TypeError: Cannot read properties of undefined]',
                    expected: 'none of [/\\bReferenceError: /, /\\bTypeError: /]',
                },
            ]);
        });

        it('passes the error names in prose or in longer names by default', async () => {
            const log = 'Handled a TypeError from the page\nMyTypeError: not a real one\nTypeErrors: none';
            expect(await failures(fakeRun({ log }), { datasetItemCount: 10 })).toEqual([]);
        });

        it('takes strings anywhere in a line and regular expressions', async () => {
            const log = 'INFO all good\nWARN Proxy blocked\nERROR Captcha 3 times';
            const failed = await checks(fakeRun({ log }), {
                datasetItemCount: 10,
                forbiddenLogs: ['blocked', /Captcha \d+ times/],
            });
            expect(failed.map(({ actual }) => actual)).toEqual(['[WARN Proxy blocked | ERROR Captcha 3 times]']);
        });

        it('quotes at most three lines', async () => {
            const log = Array.from({ length: 5 }, (_, i) => `TypeError: ${i}`).join('\n');
            const failed = await checks(fakeRun({ log }), { datasetItemCount: 10 });
            expect(failed.map(({ actual }) => actual)).toEqual([
                '[TypeError: 0 | TypeError: 1 | TypeError: 2] and 2 more',
            ]);
        });
    });

    describe('chargedEventCounts', () => {
        const run = fakeRun({ chargedEventCounts: { start: 1, item: 7 } });

        it('passes matching counts and intervals', async () => {
            const options = { datasetItemCount: 10, chargedEventCounts: { start: 1, item: { min: 5 } } };
            expect(await failures(run, options)).toEqual([]);
        });

        it('checks only the events listed', async () => {
            const options = { datasetItemCount: 10, chargedEventCounts: { start: 1 } as Record<string, number> };
            expect(await failures(run, options)).toEqual([]);
        });

        it('counts an event that was never charged as 0', async () => {
            const options = { datasetItemCount: 10, chargedEventCounts: { premium: 0, extra: { min: 1 } } };
            expect(await failures(run, options)).toEqual(['chargedEventCounts.extra']);
        });

        it('fails any charged event not listed in strict mode', async () => {
            const options = {
                datasetItemCount: 10,
                chargedEventCounts: { start: 1 } as Record<string, number>,
                strictChargedEventCounts: true,
            };
            expect(await failures(run, options)).toEqual(['chargedEventCounts.item']);
        });
    });
});
