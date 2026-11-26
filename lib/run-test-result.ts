import type { ActorRun, ApifyClient, KeyValueStoreClient } from 'apify-client';

import { STATISTICS_KEY_PREFIXES } from './consts.js';
import { MissingStatisticsError } from './missing-statistics-error.js';
import type { CrawlerStatistics, CrawlerStatisticsRecord, Dataset } from './types.js';

/** Items fetched per request, so no single response can exceed Node's string limit on large datasets. */
const DATASET_PAGE_SIZE = 1000;

/** Statistics records found per key prefix: the first page of keys, far more crawlers than any run has */
const STATISTICS_KEYS_LIMIT = 1000;

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

const sumStatistics = (records: { key: string; record: CrawlerStatisticsRecord }[]): CrawlerStatistics => {
    const sum = (field: keyof CrawlerStatisticsRecord) =>
        records.reduce((total, { record }) => total + ((record[field] as number | undefined) ?? 0), 0);
    // Request counts by their number of retries, added up per number of retries
    const histogram: number[] = [];
    for (const { record } of records) {
        (record.requestRetryHistogram ?? []).forEach((count, retries) => {
            histogram[retries] = (histogram[retries] ?? 0) + count;
        });
    }
    return {
        keys: records.map(({ key }) => key),
        requestsFinished: sum('requestsFinished'),
        requestsFailed: sum('requestsFailed'),
        requestsRetries: sum('requestsRetries'),
        requestRetryHistogram: histogram,
        // one bucket per number of retries, so the last one is the most retries any request needed
        maxRetriesPerRequest: Math.max(0, histogram.length - 1),
        requestTotalFinishedDurationMillis: sum('requestTotalFinishedDurationMillis'),
        requestTotalFailedDurationMillis: sum('requestTotalFailedDurationMillis'),
    };
};

export class RunTestResult {
    constructor(
        private readonly apifyClient: ApifyClient,
        private readonly run: ActorRun,
    ) {
        /**/
    }

    private readonly statisticsRecords = new Map<string, () => Promise<CrawlerStatisticsRecord | undefined>>();

    private readonly readStatisticsRecord = async (key: string): Promise<CrawlerStatisticsRecord | undefined> => {
        if (!this.statisticsRecords.has(key)) {
            this.statisticsRecords.set(
                key,
                once(
                    async () => (await this.getKeyValueStoreClient().getRecord(key))?.value as CrawlerStatisticsRecord,
                ),
            );
        }
        return this.statisticsRecords.get(key)!();
    };

    /** The keys of the run's statistics records, sorted, from the first page of keys under each prefix */
    private readonly statisticsKeys = once(async (): Promise<string[]> => {
        const store = this.getKeyValueStoreClient();
        const pages = await Promise.all(
            STATISTICS_KEY_PREFIXES.map(async (prefix) => store.listKeys({ prefix, limit: STATISTICS_KEYS_LIMIT })),
        );
        const keys = pages
            .flatMap(({ items }) => items.map(({ key }) => key))
            .filter((key) => STATISTICS_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));
        // Each key once, also if a listing ignored its prefix
        return [...new Set(keys)].sort();
    });

    /**
     * The crawler statistics of the run, summed over every record read, as `toFinishWith` checks them. By default every
     * record whose key starts with `SDK_CRAWLER_STATISTICS_` or `CRAWLEE_CRAWLER_STATISTICS_`, from the first 1,000
     * keys under each prefix, or `undefined` when the run has none, e.g. without a Crawlee crawler.
     *
     * @param keys - Only these records, e.g. one crawler's out of several.
     * @throws MissingStatisticsError when a record named in `keys` doesn't exist.
     */
    getStatistics = async (keys?: string | string[]): Promise<CrawlerStatistics | undefined> => {
        const wanted = keys === undefined ? await this.statisticsKeys() : [keys].flat();
        if (wanted.length === 0) return undefined;
        const records = await Promise.all(
            wanted.map(async (key) => ({ key, record: await this.readStatisticsRecord(key) })),
        );
        const missing = records.filter(({ record }) => !record).map(({ key }) => key);
        if (missing.length > 0) throw new MissingStatisticsError(missing);
        return sumStatistics(records as { key: string; record: CrawlerStatisticsRecord }[]);
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
