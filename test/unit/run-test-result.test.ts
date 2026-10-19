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
        expect(listItems).toHaveBeenCalledTimes(3);
    });

    it('counts dataset items without downloading them', async () => {
        const listItems = vi.fn(async () => ({ total: 123, items: [{}] }));
        const client = { dataset: () => ({ listItems }) } as unknown as ApifyClient;

        expect(await new RunTestResult(client, run).getDatasetItemCount()).toBe(123);
        expect(listItems).toHaveBeenCalledWith({ limit: 1 });
    });
});
