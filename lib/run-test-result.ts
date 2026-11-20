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

/** Crawlee v3 writes `SDK_CRAWLER_STATISTICS_<n>`, v4 `CRAWLEE_CRAWLER_STATISTICS_<n>`. */
const STATISTICS_KEY_PREFIXES = ['SDK_CRAWLER_STATISTICS_', 'CRAWLEE_CRAWLER_STATISTICS_'];

export class RunTestResult {
    constructor(
        private readonly apifyClient: ApifyClient,
        private readonly run: ActorRun,
    ) {
        /**/
    }

    /** A crawler that replaces its statistics (adaptive Playwright) lands on the next `<n>`, so the highest one is the live record. */
    getStatistics = once(async (): Promise<SdkCrawlerStatistics | undefined> => {
        const store = this.getKeyValueStoreClient();
        // Listed by prefix: a plain listing stops at 1000 keys, which a store with many records would fill first.
        const pages = await Promise.all(STATISTICS_KEY_PREFIXES.map(async (prefix) => store.listKeys({ prefix })));
        const [key] = pages
            .flatMap(({ items }) => items.map(({ key: name }) => name))
            .filter((name) => /_\d+$/.test(name))
            .sort((x, y) => Number(y.slice(y.lastIndexOf('_') + 1)) - Number(x.slice(x.lastIndexOf('_') + 1)));
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
