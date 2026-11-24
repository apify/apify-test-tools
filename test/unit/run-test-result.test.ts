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

    it('returns a record decoded by the client, and nothing for a missing key', async () => {
        const getRecord = vi.fn(async (key: string) =>
            key === 'OUTPUT' ? { key, value: { a: 1 }, contentType: 'application/json' } : undefined,
        );
        const client = { keyValueStore: () => ({ getRecord }) } as unknown as ApifyClient;
        const result = new RunTestResult(client, run);

        expect(await result.getRecord('OUTPUT')).toStrictEqual({ value: { a: 1 }, contentType: 'application/json' });
        expect(await result.getRecord('MISSING')).toBeUndefined();
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
});

describe('RunTestResult.getStatistics', () => {
    const clientWithKeys = (keys: string[]) =>
        ({
            keyValueStore: () => ({
                listKeys: async ({ prefix = '' }: { prefix?: string } = {}) => ({
                    items: keys.filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
                }),
                getRecord: async (key: string) => ({ value: { key } }),
            }),
        }) as unknown as ApifyClient;

    it('picks the highest-numbered record across crawlee v3 and v4 names', async () => {
        const keys = [
            'INPUT',
            'SDK_CRAWLER_STATISTICS_0',
            'CRAWLEE_CRAWLER_STATISTICS_10',
            'CRAWLEE_CRAWLER_STATISTICS_2',
        ];
        expect(await new RunTestResult(clientWithKeys(keys), run).getStatistics()).toStrictEqual({
            key: 'CRAWLEE_CRAWLER_STATISTICS_10',
        });
    });

    it('is undefined for non-crawler Actors', async () => {
        expect(await new RunTestResult(clientWithKeys(['INPUT']), run).getStatistics()).toBeUndefined();
    });
});
