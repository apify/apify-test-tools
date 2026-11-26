import type { ActorRun, ApifyClient } from 'apify-client';
import { describe, expect, it, vi } from 'vitest';

import { MissingStatisticsError } from '../../lib/missing-statistics-error.js';
import { RunTestResult } from '../../lib/run-test-result.js';

const run = { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'ds', defaultKeyValueStoreId: 'kvs' } as ActorRun;

describe('RunTestResult', () => {
    it('fetches the log once, even when empty or requested concurrently', async () => {
        const get = vi.fn(async () => '');
        const client = { run: () => ({ log: () => ({ get }) }) } as unknown as ApifyClient;
        const result = new RunTestResult(client, run);

        await Promise.all([result.getLog(), result.getLog()]);
        await result.getLog();

        expect(get).toHaveBeenCalledTimes(1);
    });

    it('retries after a failed fetch', async () => {
        const get = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('log');
        const client = { run: () => ({ log: () => ({ get }) }) } as unknown as ApifyClient;
        const result = new RunTestResult(client, run);

        await expect(result.getLog()).rejects.toThrow('boom');
        expect(await result.getLog()).toBe('log');
    });

    it('pages through the dataset instead of listing it in one response', async () => {
        const total = 25_000;
        const listItems = vi.fn(async ({ offset, limit }: { offset: number; limit: number }) => ({
            total,
            items: Array.from({ length: Math.min(limit, total - offset) }, (_, i) => offset + i),
        }));
        const client = { dataset: () => ({ listItems }) } as unknown as ApifyClient;
        const result = new RunTestResult(client, run);

        const { items } = await result.getDataset<number>();

        expect(items).toHaveLength(total);
        expect(items[24_999]).toBe(24_999);
        expect(listItems).toHaveBeenCalledTimes(25);
    });

    describe('getStatistics', () => {
        const STATS = {
            requestsFinished: 10,
            requestsFailed: 1,
            requestsRetries: 2,
            requestRetryHistogram: [8, 2],
            requestTotalFinishedDurationMillis: 1000,
            requestTotalFailedDurationMillis: 100,
            crawlerStartedAt: '2026-01-01T00:00:00.000Z',
        };

        // A key-value store with these records, whose listing honours the prefix unless `ignorePrefix`
        const fakeStore = (records: Record<string, object>, { ignorePrefix = false } = {}) => {
            const getRecord = vi.fn(async (key: string) => (key in records ? { key, value: records[key] } : undefined));
            const listKeys = vi.fn(async ({ prefix }: { prefix: string }) => ({
                items: Object.keys(records)
                    .filter((key) => ignorePrefix || key.startsWith(prefix))
                    .map((key) => ({ key })),
            }));
            const client = { keyValueStore: () => ({ getRecord, listKeys }) } as unknown as ApifyClient;
            return { result: new RunTestResult(client, run), getRecord, listKeys };
        };

        it('sums every record under both prefixes by default', async () => {
            const { result, listKeys } = fakeStore({
                SDK_CRAWLER_STATISTICS_0: STATS,
                CRAWLEE_CRAWLER_STATISTICS_0: { ...STATS, requestRetryHistogram: [5, 0, 1] },
                SDK_CRAWLER_STATISTICS_1: { requestsFinished: 1 },
                INPUT: { requestsFinished: 100 },
            });

            expect(await result.getStatistics()).toEqual({
                keys: ['CRAWLEE_CRAWLER_STATISTICS_0', 'SDK_CRAWLER_STATISTICS_0', 'SDK_CRAWLER_STATISTICS_1'],
                requestsFinished: 21,
                requestsFailed: 2,
                requestsRetries: 4,
                requestRetryHistogram: [13, 2, 1],
                maxRetriesPerRequest: 2,
                requestTotalFinishedDurationMillis: 2000,
                requestTotalFailedDurationMillis: 200,
            });
            expect(listKeys.mock.calls.map(([options]) => options)).toEqual([
                { prefix: 'SDK_CRAWLER_STATISTICS_', limit: 1000 },
                { prefix: 'CRAWLEE_CRAWLER_STATISTICS_', limit: 1000 },
            ]);
        });

        it('keeps only the keys under the prefixes, in case the listing ignores the prefix', async () => {
            const { result } = fakeStore({ INPUT: STATS, SDK_CRAWLER_STATISTICS_0: STATS }, { ignorePrefix: true });
            expect((await result.getStatistics())?.keys).toEqual(['SDK_CRAWLER_STATISTICS_0']);
        });

        it('is undefined for a run without statistics', async () => {
            const { result, getRecord } = fakeStore({ INPUT: STATS });
            expect(await result.getStatistics()).toBeUndefined();
            expect(getRecord).not.toHaveBeenCalled();
        });

        it('reads only the records given, one key or several', async () => {
            const { result, listKeys } = fakeStore({ SDK_CRAWLER_STATISTICS_0: STATS, CUSTOM: STATS, OTHER: STATS });
            expect(await result.getStatistics('CUSTOM')).toMatchObject({ keys: ['CUSTOM'], requestsFinished: 10 });
            expect(await result.getStatistics(['CUSTOM', 'OTHER'])).toMatchObject({ requestsFinished: 20 });
            expect(listKeys).not.toHaveBeenCalled();
        });

        it('throws naming the records given that the run lacks', async () => {
            const { result } = fakeStore({ SDK_CRAWLER_STATISTICS_0: STATS });
            const error = await result.getStatistics(['SDK_CRAWLER_STATISTICS_0', 'A', 'B']).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(MissingStatisticsError);
            expect(error).toMatchObject({ keys: ['A', 'B'], message: 'The run has no statistics record A, B' });
        });

        it('lists the keys and reads each record once', async () => {
            const { result, getRecord, listKeys } = fakeStore({ SDK_CRAWLER_STATISTICS_0: STATS });
            await Promise.all([result.getStatistics(), result.getStatistics()]);
            await result.getStatistics('SDK_CRAWLER_STATISTICS_0');
            expect(listKeys).toHaveBeenCalledTimes(2);
            expect(getRecord).toHaveBeenCalledTimes(1);
        });
    });
});
