import type { ActorRun, ApifyClient, KeyValueStoreClient } from 'apify-client';

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

/** What `toFinishWith` and the other matchers need from a finished run, wherever it ran. */
export interface RunOutcome {
    readonly status: string;
    getRunInfo(): Promise<{ stats: { durationMillis: number }; chargedEventCounts?: Record<string, number> }>;
    getDataset<T>(): Promise<Dataset<T>>;
    getStatistics(): Promise<SdkCrawlerStatistics | undefined>;
    getLog(): Promise<string>;
}

/** Crawlee v3 writes `SDK_CRAWLER_STATISTICS_<n>`, v4 `CRAWLEE_CRAWLER_STATISTICS_<n>`. */
const STATISTICS_KEY_PREFIXES = ['SDK_CRAWLER_STATISTICS_', 'CRAWLEE_CRAWLER_STATISTICS_'];
/** With `.json` when it comes from a Crawlee 3 local store, where the key is the filename. */
const STATISTICS_KEY = /^(?:SDK|CRAWLEE)_CRAWLER_STATISTICS_(\d+)(?:\.json)?$/;

/** A crawler that replaces its statistics (adaptive Playwright) lands on the next `<n>`, so the highest one is the live record. */
export const pickStatisticsKey = (keys: string[]): string | undefined =>
    keys
        .map((key) => ({ key, index: Number(STATISTICS_KEY.exec(key)?.[1] ?? NaN) }))
        .filter(({ index }) => !Number.isNaN(index))
        .sort((a, b) => b.index - a.index)[0]?.key;

export class RunTestResult implements RunOutcome {
    constructor(
        private readonly apifyClient: ApifyClient,
        private readonly run: ActorRun,
    ) {
        /**/
    }

    getStatistics = once(async (): Promise<SdkCrawlerStatistics | undefined> => {
        const store = this.getKeyValueStoreClient();
        // Listed by prefix: a plain listing stops at 1000 keys, which a store with many records would fill first.
        const pages = await Promise.all(STATISTICS_KEY_PREFIXES.map(async (prefix) => store.listKeys({ prefix })));
        const key = pickStatisticsKey(pages.flatMap(({ items }) => items.map(({ key: name }) => name)));
        if (!key) return undefined;
        return (await store.getRecord(key))?.value as SdkCrawlerStatistics | undefined;
    });

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
