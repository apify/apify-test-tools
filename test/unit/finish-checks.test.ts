import { describe, expect, it } from 'vitest';

import { getFinishChecks } from '../../lib/finish-checks.js';
import type { RunTestResult } from '../../lib/run-test-result.js';
import type { SdkCrawlerStatistics, ToFinishWithOptions } from '../../lib/types.js';

const fakeRun = ({
    status = 'SUCCEEDED',
    durationMillis = 5000,
    itemCount = 10,
    stats = { requestsFailed: 0, requestsRetries: 0, requestRetryHistogram: [5] } as Partial<SdkCrawlerStatistics>,
    chargedEventCounts = undefined as Record<string, number> | undefined,
    log = 'all good',
} = {}) =>
    ({
        status,
        getRunInfo: async () => ({ stats: { durationMillis }, chargedEventCounts }),
        getDataset: async () => ({ items: new Array(itemCount) }),
        getStatistics: async () => stats,
        getLog: async () => log,
    }) as unknown as RunTestResult;

const failures = async (run: RunTestResult, options: ToFinishWithOptions<string>) =>
    (await getFinishChecks(run, options)).filter((check) => !check.ok);

describe('getFinishChecks()', () => {
    it('treats explicitly undefined options as disabled checks', async () => {
        const options = { datasetItemCount: 10, duration: undefined, maxRetriesPerRequest: undefined };
        expect(await failures(fakeRun(), options)).toEqual([]);
    });

    it('passes a healthy run', async () => {
        expect(await failures(fakeRun(), { datasetItemCount: { min: 5, max: 20 } })).toEqual([]);
    });

    it('reports every failing check with its actual and expected values', async () => {
        const run = fakeRun({ status: 'FAILED', itemCount: 3, durationMillis: 100 });
        const failed = await failures(run, { datasetItemCount: { min: 5 } });
        expect(failed.map((check) => [check.actual, check.expected])).toEqual([
            ['status=FAILED', 'status=SUCCEEDED'],
            ['datasetItemCount=3', 'datasetItemCount=<5,>'],
            ['duration=100', 'duration=<600,600000>'],
        ]);
    });

    it('accepts an exact number and skips checks set to null', async () => {
        const run = fakeRun({ itemCount: 7, durationMillis: 1 });
        expect(await failures(run, { datasetItemCount: 7, duration: null })).toEqual([]);
        expect(await failures(run, { datasetItemCount: 8, duration: null })).toHaveLength(1);
    });

    it('fails an interval check when the statistics are missing', async () => {
        const failed = await failures(fakeRun({ stats: {} }), { datasetItemCount: 10 });
        expect(failed.map((check) => check.actual)).toEqual(['failedRequests=undefined', 'requestsRetries=undefined']);
    });

    it('checks the maximum retries per request only when asked', async () => {
        const stats = { requestsFailed: 0, requestsRetries: 0, requestRetryHistogram: [5, 2, 1] };
        expect(await failures(fakeRun({ stats }), { datasetItemCount: 10 })).toEqual([]);
        const failed = await failures(fakeRun({ stats }), { datasetItemCount: 10, maxRetriesPerRequest: 1 });
        expect(failed.map((check) => check.actual)).toEqual(['maxRetriesPerRequest=2']);
    });

    it('fails on forbidden logs', async () => {
        const failed = await failures(fakeRun({ log: 'boom: TypeError: x' }), { datasetItemCount: 10 });
        expect(failed.map((check) => check.actual)).toEqual(['logs=[TypeError]']);
    });

    describe('chargedEventCounts', () => {
        const options = (chargedEventCounts: Record<string, { min: number } | number>) => ({
            datasetItemCount: 10,
            chargedEventCounts,
        });

        it('passes when the counts match', async () => {
            const run = fakeRun({ chargedEventCounts: { start: 1, item: 12 } });
            expect(await failures(run, options({ start: 1, item: { min: 10 } }))).toEqual([]);
        });

        it('expects an event that was not listed to never be charged', async () => {
            const run = fakeRun({ chargedEventCounts: { start: 1, extra: 2 } });
            const failed = await failures(run, options({ start: 1 }));
            expect(failed.map((check) => [check.actual, check.expected])).toEqual([
                ['chargedEventCounts[extra]=2', 'chargedEventCounts[extra]=0'],
            ]);
        });

        it('fails a listed event that was never charged', async () => {
            const failed = await failures(fakeRun({ chargedEventCounts: {} }), options({ start: { min: 0 } }));
            expect(failed.map((check) => check.actual)).toEqual(['chargedEventCounts[start]=X']);
        });
    });
});
