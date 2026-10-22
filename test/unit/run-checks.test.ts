import { describe, expect, it } from 'vitest';

import { checkRun } from '../../lib/run-checks.js';
import type { RunTestResult } from '../../lib/run-test-result.js';

const fakeRun = (overrides: { status?: string; log?: string; stats?: object; chargedEventCounts?: object } = {}) =>
    ({
        status: overrides.status ?? 'SUCCEEDED',
        getRunInfo: async () => ({
            stats: { durationMillis: 5_000 },
            chargedEventCounts: overrides.chargedEventCounts,
        }),
        getDatasetItemCount: async () => 10,
        getStatistics: async () => ({
            requestsFailed: 0,
            requestsRetries: 1,
            requestRetryHistogram: [5, 1],
            ...overrides.stats,
        }),
        getLog: async () => overrides.log ?? 'all good',
    }) as unknown as RunTestResult;

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

    it('checks the longest retry chain only when asked to', async () => {
        expect(await failures(fakeRun(), { datasetItemCount: 10, maxRetriesPerRequest: 0 })).toEqual([
            'maxRetriesPerRequest',
        ]);
        expect(await failures(fakeRun(), { datasetItemCount: 10, maxRetriesPerRequest: 1 })).toEqual([]);
    });

    describe('chargedEventCounts', () => {
        const run = fakeRun({ chargedEventCounts: { start: 1, item: 7 } });

        it('passes matching counts and intervals', async () => {
            const options = { datasetItemCount: 10, chargedEventCounts: { start: 1, item: { min: 5 } } };
            expect(await failures(run, options)).toEqual([]);
        });

        it('expects unlisted charged events to not happen', async () => {
            const options = { datasetItemCount: 10, chargedEventCounts: { start: 1 } as Record<string, number> };
            expect(await failures(run, options)).toEqual(['chargedEventCounts.item']);
        });

        it('fails an expected event that was never charged', async () => {
            const options = { datasetItemCount: 10, chargedEventCounts: { start: 1, item: 7, extra: { min: 0 } } };
            expect(await failures(run, options)).toEqual(['chargedEventCounts.extra']);
        });
    });
});
