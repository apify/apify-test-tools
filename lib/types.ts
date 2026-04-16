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

/**
 * Named trigger types that can gate a test or suite.
 * The active trigger is supplied via the `TEST_TRIGGER` environment variable.
 */
export type TriggerType = 'hourly' | 'daily' | 'pullRequest';

/**
 * Controls which trigger types cause the test/suite to be included in the run.
 * When `TEST_TRIGGER` is not set, all tests run regardless of `runWhen`.
 *
 * Each field defaults to the value set in `DEFAULT_TRIGGERS` (currently `daily` and
 * `pullRequest` are true, `hourly` is false). Set a field to `false` to opt out of
 * a trigger, or `true` to opt in.
 *
 * Keys are merged field-by-field through the describe hierarchy, so a child
 * only needs to override the specific trigger it wants to change.
 *
 * Example — disable only PR runs:
 * ```ts
 * runWhen: { pullRequest: false }
 * ```
 */
export type RunWhenConfig = Partial<Record<TriggerType, boolean>>;

/**
 * Defines which alerting channels fire when this test/suite fails.
 * Evaluated by the `report-tests` command after the run.
 * Keys are merged field-by-field through the describe hierarchy.
 *
 * Example:
 * ```ts
 * alerts: { slack: true }
 * ```
 */
export type AlertsConfig = {
    slack?: boolean;
};

/**
 * Trigger and alerting configuration, shared between `DescribeConfig` and
 * `TestActorConfig`. Inherited and merged field-by-field down the describe
 * hierarchy so children only need to override what they want to change.
 */
export type TriggerConfig = {
    runWhen?: RunWhenConfig;
    alerts?: AlertsConfig;
};

/** Vitest-level options for a `describe` suite. */
export type DescribeOptions = {
    timeout?: number;
    concurrent?: boolean;
    sequential?: boolean;
};

/** Vitest-level options for an individual `testActor` / `testStandbyActor`. */
export type ActorOptions = {
    retry?: number;
    timeout?: number;
};

/**
 * Config object passed as the first argument to `describe`.
 * `triggers` is inherited and merged with nested describes / testActors.
 *
 * Example:
 * ```ts
 * describe({
 *   name: 'my-actor',
 *   triggers: { runWhen: { daily: true }, alerts: { slack: true } },
 *   options: { concurrent: false },
 * }, () => { ... });
 * ```
 */
export type DescribeConfig = {
    name: string;
    triggers?: TriggerConfig;
    options?: DescribeOptions;
};

/**
 * Config object passed as the second argument to `testActor` / `testStandbyActor`.
 * `triggers` merges field-by-field with whatever was set on enclosing describes.
 *
 * Example:
 * ```ts
 * testActor(actorId, {
 *   name: 'smoke',
 *   triggers: { runWhen: { hourly: true } },
 *   options: { retry: 2 },
 * }, async ({ run }) => { ... });
 * ```
 */
export type TestActorConfig = {
    name: string;
    triggers?: TriggerConfig;
    options?: ActorOptions;
};

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
