import type { ActorRun, ApifyClient } from 'apify-client';
import { describe, expect, it, vi } from 'vitest';

import { RunTestResult } from '../../lib/run-test-result.js';

const run = { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds', defaultKeyValueStoreId: 'kvs' } as ActorRun;

const makeClient = ({ items = [] as unknown[], records = {} as Record<string, unknown> } = {}) => {
    const listItems = vi.fn(async ({ offset, limit }: { offset: number; limit: number }) => ({
        items: items.slice(offset, offset + limit),
    }));
    const getRecord = vi.fn(async (key: string) => (key in records ? { value: records[key] } : undefined));
    const client = {
        dataset: () => ({ listItems }),
        keyValueStore: () => ({ getRecord }),
        run: () => ({ get: async () => ({ id: 'run1' }), log: () => ({ get: async () => 'the log' }) }),
    } as unknown as ApifyClient;
    return { client, listItems, getRecord };
};

describe('RunTestResult', () => {
    it('downloads the dataset in pages, so a large one never exceeds one response', async () => {
        const items = Array.from({ length: 12_500 }, (_, i) => ({ i }));
        const { client, listItems } = makeClient({ items });

        const dataset = await new RunTestResult(client, run).getDataset();

        expect(dataset.items).toEqual(items);
        expect(listItems.mock.calls.map(([{ offset }]) => offset)).toEqual([
            0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000, 11_000, 12_000,
        ]);
    });

    it('loads each piece of data once, even when requested concurrently', async () => {
        const { client, listItems, getRecord } = makeClient({ items: [{ a: 1 }], records: { INPUT: { q: 1 } } });
        const result = new RunTestResult(client, run);

        await Promise.all([result.getDataset(), result.getDataset(), result.getInput(), result.getInput()]);

        expect(listItems).toHaveBeenCalledTimes(1);
        expect(getRecord).toHaveBeenCalledTimes(1);
    });

    it('caches falsy values too', async () => {
        const { client, getRecord } = makeClient({ records: { INPUT: 0 } });
        const result = new RunTestResult(client, run);

        expect(await result.getInput()).toBe(0);
        expect(await result.getInput()).toBe(0);
        expect(getRecord).toHaveBeenCalledTimes(1);
    });

    it('retries after a failed load', async () => {
        const { client, getRecord } = makeClient({ records: { INPUT: 1 } });
        getRecord.mockRejectedValueOnce(new Error('boom'));
        const result = new RunTestResult(client, run);

        await expect(result.getInput()).rejects.toThrow('boom');
        expect(await result.getInput()).toBe(1);
    });

    it('returns undefined statistics when the record is missing', async () => {
        expect(await new RunTestResult(makeClient().client, run).getStatistics()).toBeUndefined();
    });
});
