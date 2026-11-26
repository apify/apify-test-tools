import type { ActorRun, ApifyClient } from 'apify-client';
import { describe, expect, it, vi } from 'vitest';

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

    it('reads the statistics of the default crawler or of the key given, each once', async () => {
        const getRecord = vi.fn(async (key: string) => (key === 'missing' ? undefined : { key, value: { key } }));
        const client = { keyValueStore: () => ({ getRecord }) } as unknown as ApifyClient;
        const result = new RunTestResult(client, run);

        expect(await result.getStatistics()).toEqual({ key: 'SDK_CRAWLER_STATISTICS_0' });
        expect(await result.getStatistics('CUSTOM')).toEqual({ key: 'CUSTOM' });
        expect(await result.getStatistics('missing')).toBeUndefined();
        await result.getStatistics('CUSTOM');

        expect(getRecord.mock.calls.map(([key]) => key)).toEqual(['SDK_CRAWLER_STATISTICS_0', 'CUSTOM', 'missing']);
    });

    it('lists the statistics records under both prefixes once, sorted, keeping only keys that match', async () => {
        const keys: Record<string, string[]> = {
            SDK_CRAWLER_STATISTICS_: ['SDK_CRAWLER_STATISTICS_1', 'SDK_CRAWLER_STATISTICS_0'],
            // The prefix is matched again, in case the listing ignores it
            CRAWLEE_CRAWLER_STATISTICS_: ['CRAWLEE_CRAWLER_STATISTICS_0', 'INPUT'],
        };
        const listKeys = vi.fn(async ({ prefix }: { prefix: string }) => ({
            items: keys[prefix].map((key) => ({ key })),
        }));
        const client = { keyValueStore: () => ({ listKeys }) } as unknown as ApifyClient;
        const result = new RunTestResult(client, run);

        await Promise.all([result.getStatisticsKeys(), result.getStatisticsKeys()]);
        expect(await result.getStatisticsKeys()).toEqual([
            'CRAWLEE_CRAWLER_STATISTICS_0',
            'SDK_CRAWLER_STATISTICS_0',
            'SDK_CRAWLER_STATISTICS_1',
        ]);
        expect(listKeys.mock.calls.map(([options]) => options)).toEqual([
            { prefix: 'SDK_CRAWLER_STATISTICS_', limit: 1000 },
            { prefix: 'CRAWLEE_CRAWLER_STATISTICS_', limit: 1000 },
        ]);
    });
});
