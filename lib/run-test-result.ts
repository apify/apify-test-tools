import { ActorRun, ApifyClient, KeyValueStoreClient } from 'apify-client';
import type { Dataset, SdkCrawlerStatistics } from './types';

export class RunTestResult {
    private log: string | undefined;
    private dataset: Dataset<unknown> | undefined;
    private keyValueStoreClient: KeyValueStoreClient | undefined;
    private statistics: SdkCrawlerStatistics | undefined;
    private runInfo: ActorRun | undefined;
    private input: unknown | undefined;

    constructor(
        private readonly apifyClient: ApifyClient,
        private readonly run: ActorRun,
    ) { /**/ }

    getStatistics = async (): Promise<SdkCrawlerStatistics | undefined> => {
        if (this.statistics) {
            return this.statistics;
        }
        const kvs = this.apifyClient.keyValueStore(this.run.defaultKeyValueStoreId);
        const stats = await kvs.getRecord('SDK_CRAWLER_STATISTICS_0');
        this.statistics = stats?.value as unknown as SdkCrawlerStatistics;
        return this.statistics;
    };

    getLog = async (): Promise<string> => {
        if (this.log) {
            return this.log;
        }
        const runLog = await this.apifyClient.run(this.id).log().get();
        this.log = runLog;
        return runLog as string;
    };

    getDataset = async<T>(): Promise<Dataset<T>> => {
        if (this.dataset) {
            return this.dataset as Dataset<T>;
        }
        const dataset = this.apifyClient.dataset(this.run.defaultDatasetId);
        const items = (await dataset.listItems()).items as T[];
        this.dataset = { items };
        return this.dataset as Dataset<T>;
    };

    getKeyValueStoreClient = (): KeyValueStoreClient => {
        if (this.keyValueStoreClient) {
            return this.keyValueStoreClient;
        }
        const keyValueStoreClient = this.apifyClient.keyValueStore(this.run.defaultKeyValueStoreId);
        this.keyValueStoreClient = keyValueStoreClient;
        return keyValueStoreClient
    };

    getInput = async<T>(): Promise<T> => {
        if (this.input) {
            return this.input as T
        }
        const kvs = this.apifyClient.keyValueStore(this.run.defaultKeyValueStoreId);
        const input = await kvs.getRecord('INPUT');
        this.input = input?.value;
        return this.input as T;
    }

    getRunInfo = async (): Promise<ActorRun> => {
        if (this.runInfo) {
            return this.runInfo;
        }
        const run = this.apifyClient.run(this.run.id);
        this.runInfo = await run.get();
        return this.runInfo!;
    };

    get id(): string {
        return this.run.id;
    }

    get status(): string {
        return this.run.status;
    }
}
