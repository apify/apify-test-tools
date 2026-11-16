import type { ActorRun, ApifyClient, KeyValueStoreClient } from 'apify-client';

import { DEFAULT_STATISTICS_KEY } from './consts.js';
import type { Dataset, SdkCrawlerStatistics } from './types.js';

/** Items fetched per request, so no single response can exceed Node's string limit on large datasets. */
const DATASET_PAGE_SIZE = 1000;

/**
 * Runs `fn` at most once and shares its promise, so repeated and concurrent calls are one request.
 * A failure is not cached, the next call retries.
 */
const once = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
    let promise: Promise<T> | undefined;
    return async () => {
        promise ??= fn().catch((error) => {
            promise = undefined;
            throw error;
        });
        return promise;
    };
};

export class RunTestResult {
    constructor(
        private readonly apifyClient: ApifyClient,
        private readonly run: ActorRun,
    ) {
        /**/
    }

    private readonly statisticsRecords = new Map<string, () => Promise<SdkCrawlerStatistics | undefined>>();

    /**
     * The crawler statistics in the record `key` of the default key-value store, or `undefined` without one. A crawler
     * given its own statistics id, or a second crawler in the same run, persists them under another key.
     */
    getStatistics = async (key: string = DEFAULT_STATISTICS_KEY): Promise<SdkCrawlerStatistics | undefined> => {
        if (!this.statisticsRecords.has(key)) {
            this.statisticsRecords.set(
                key,
                once(async () => (await this.getKeyValueStoreClient().getRecord(key))?.value as SdkCrawlerStatistics),
            );
        }
        return this.statisticsRecords.get(key)!();
    };

    getLog = once(async (): Promise<string> => {
        return (await this.apifyClient.run(this.id).log().get()) as string;
    });

    private readonly datasetItems = once(async (): Promise<unknown[]> => {
        const dataset = this.apifyClient.dataset(this.run.defaultDatasetId);
        const items: unknown[] = [];
        for (;;) {
            const page = await dataset.listItems({ offset: items.length, limit: DATASET_PAGE_SIZE });
            items.push(...page.items);
            if (page.items.length === 0 || items.length >= page.total) {
                return items;
            }
        }
    });

    getDataset = async <T>(): Promise<Dataset<T>> => ({ items: (await this.datasetItems()) as T[] });

    getKeyValueStoreClient = (): KeyValueStoreClient => {
        return this.apifyClient.keyValueStore(this.run.defaultKeyValueStoreId);
    };

    private readonly inputRecord = once(async () => (await this.getKeyValueStoreClient().getRecord('INPUT'))?.value);

    getInput = async <T>(): Promise<T> => (await this.inputRecord()) as T;

    /** Fetches the run again, so unlike `id` and `status` it also reflects what changed after the run finished. */
    getRunInfo = once(async (): Promise<ActorRun> => {
        return (await this.apifyClient.run(this.run.id).get())!;
    });

    get id(): string {
        return this.run.id;
    }

    get status(): string {
        return this.run.status;
    }
}
