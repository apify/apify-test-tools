import type { ActorRun, ApifyClient, KeyValueStoreClient } from 'apify-client';

import type { Dataset, SdkCrawlerStatistics } from './types.js';

// Large datasets exceed the Node string limit when downloaded in one response, see
// https://github.com/apify/apify-test-tools/issues/169
const DATASET_PAGE_SIZE = 5000;

/**
 * Wraps `load` so it runs once, on first use. The promise is cached, so concurrent callers share one request
 * and a falsy result (an empty input, a missing record) is cached too.
 */
const lazy = <T>(load: () => Promise<T>): (() => Promise<T>) => {
    let cached: Promise<T> | undefined;
    return async () => {
        cached ??= load();
        return cached;
    };
};

export class RunTestResult {
    private readonly kvs: KeyValueStoreClient;

    constructor(
        private readonly apifyClient: ApifyClient,
        private readonly run: ActorRun,
    ) {
        this.kvs = apifyClient.keyValueStore(run.defaultKeyValueStoreId);
    }

    getStatistics = lazy(
        async () => (await this.kvs.getRecord('SDK_CRAWLER_STATISTICS_0'))?.value as SdkCrawlerStatistics | undefined,
    );

    getLog = lazy(async () => (await this.apifyClient.run(this.run.id).log().get()) as string);

    /** Number of items in the default dataset, without downloading them. */
    getDatasetItemCount = lazy(async () => {
        const dataset = await this.apifyClient.dataset(this.run.defaultDatasetId).get();
        return dataset?.itemCount ?? 0;
    });

    private readonly loadDataset = lazy(async (): Promise<Dataset<unknown>> => {
        const dataset = this.apifyClient.dataset(this.run.defaultDatasetId);
        const items: unknown[] = [];
        for (;;) {
            const page = await dataset.listItems({ offset: items.length, limit: DATASET_PAGE_SIZE });
            items.push(...page.items);
            if (page.items.length < DATASET_PAGE_SIZE) return { items };
        }
    });

    getDataset = async <T>(): Promise<Dataset<T>> => (await this.loadDataset()) as Dataset<T>;

    getKeyValueStoreClient = (): KeyValueStoreClient => this.kvs;

    private readonly loadInput = lazy(async () => (await this.kvs.getRecord('INPUT'))?.value);

    getInput = async <T>(): Promise<T> => (await this.loadInput()) as T;

    getRunInfo = lazy(async () => (await this.apifyClient.run(this.run.id).get())!);

    get id(): string {
        return this.run.id;
    }

    get status(): string {
        return this.run.status;
    }
}
