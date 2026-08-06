import type { ActorCallOptions } from 'apify-client';
import type { Assertion, TestOptions } from 'vitest';

export type ActorBuild = {
    buildId: string;
    actorId: string;
    buildNumber: string;
    actorName: string;
};

export type RunOptions<T> = {
    input: Omit<T, 'actorName'>;
    options?: ActorCallOptions;
    prefilledInput?: boolean;
    /**
     * If you specify `runId`, all the other options will be ignored and this run's data will
     * be downloaded instead.
     *
     * This is usefull for testing your tests on existing runs
     */
    runId?: string;
};

export type Dataset<T> = {
    items: T[];
};

export type OpenInterval =
    | {
          min: number;
          max?: undefined;
      }
    | {
          min?: undefined;
          max: number;
      };

export type ClosedInterval = {
    min: number;
    max: number;
};

export type Interval = number | OpenInterval | ClosedInterval;

export type ToFinishWithOptionsWithDefaults = {
    status: RunStatus;
    duration: Interval | null;
    failedRequests: Interval | null;
    requestsRetries: Interval | null;
    forbiddenLogs: string[];
    maxRetriesPerRequest: number | null;
};

export type ToFinishWithOptions<PpeEvent extends string> = Partial<ToFinishWithOptionsWithDefaults> & {
    datasetItemCount: Interval;
    /**
     * Define expected charged (PPE) event counts. You can also define count as `Interval`.
     *
     * Example
     * ```ts
     * chargedEventCounts: {
     *   'actor-start': 4,
     *   'item-pushed': { min: 10, max: 20 },
     * }
     * ```
     *
     * If you omit any PPE event, it's expected count will be 0.
     * Assertion will fail if `chargedEventCounts` doesn't contain some of the expected events.
     */
    chargedEventCounts?: Record<PpeEvent, Interval>;
};

export type SdkCrawlerStatistics = {
    requestsFinished: number;
    requestsFailed: number;
    requestsRetries: number;
    requestsFailedPerMinute: number;
    requestsFinishedPerMinute: number;
    requestMinDurationMillis: number;
    requestMaxDurationMillis: number;
    requestRetryHistogram: number[];
    requestTotalFailedDurationMillis: number;
    requestTotalFinishedDurationMillis: number;
    crawlerStartedAt: string;
    crawlerFinishedAt: string;
    statsPersistedAt: string;
    crawlerRuntimeMillis: number;
    crawlerLastStartTimestamp: number;
};

export type RunStatus =
    | 'SUCCEEDED'
    | 'READY'
    | 'RUNNING'
    | 'FAILED'
    | 'ABORTING'
    | 'ABORTED'
    | 'TIMING-OUT'
    | 'TIMED-OUT';

export interface ActorMatchers<R = unknown> {
    toBeArray: () => R;
    toBeBoolean: () => R;
    toBeEmptyArray: () => R;
    toBeNonEmptyArray: () => R;
    toBeNonEmptyString: () => R;
    toBeNumber: () => R;
    toBeFalse: () => R;
    toBeTrue: () => R;
    toBeNonEmptyObject: () => R;
    toBeObject: () => R;
    toBeString: () => R;
    toBeWholeNumber: () => R;
    toBeWithinRange: (lower: number, upper: number) => R;
    /**
     * Validates the following properties of a run:
     * - `status` (default: `SUCCEEDED`)
     * - `duration` in milliseconds (default: `{ min: 600, max: 600_000}` - <0.6s, 10min>)
     * - `failedRequests` (default: `0`)
     * - `requestsRetries` (default: `{ max: 3 }`)
     * - `forbiddenLogs` (default: `['ReferenceError', 'TypeError']`)
     * - `maxRetriesPerRequest` (not checked by default)
     * - `datasetItemCount` (required)
     * - `chargedEventCounts`
     */
    toFinishWith: <PpeEvent extends string>(options: ToFinishWithOptions<PpeEvent>) => Promise<R>;
    toStartWith: (prefix: string) => R;
    hard: <T>(actual: T, message?: string) => Assertion;
}

export type ActorTestOptions = Omit<TestOptions, 'retry' | 'timeout'> & {
    /**
     * Times to retry the test if fails. Useful for making flaky tests more stable.
     * When retries is up, the last test error will be thrown.
     *
     * @default 1
     */
    // we are just extending the docs here to replace the default value, otherwise it's the exact same
    retry?: TestOptions['retry'];
    /**
     * Timeout for the actor run in milliseconds. Zero value means there is no timeout.
     * - If `undefined`, the run uses timeout of the default Actor run configuration.
     *
     * @default 60 * 60 * 1000 // 1 hour
     */
    timeout?: ActorCallOptions['timeout'];
};

declare module 'vitest' {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
    interface Assertion<T = any> extends ActorMatchers<T> {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
    interface Matchers<T = any> extends ActorMatchers<T> {}
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface AsymmetricMatchersContaining extends ActorMatchers {}
}
