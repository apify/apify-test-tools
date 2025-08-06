import { Assertion } from 'vitest';

export type ActorBuild = {
    buildId: string;
    actorId: string;
    buildNumber: string;
    actorName: string;
}

export type RunOptions<T> = {
    input: Omit<T, 'actorName'>
}

export type Dataset<T> = {
    items: T[]
}

export type OpenInterval = {
    min: number
    max?: undefined
} | {
    min?: undefined
    max: number
}

export type ClosedInterval = {
    min: number
    max: number
}

export type Interval = number | OpenInterval | ClosedInterval

export type ToFinishWithOptionsWithDefaults = {
    status: RunStatus
    duration: Interval | null
    failedRequests: Interval | null
    requestsRetries: Interval | null
    forbiddenLogs: string[]
}
export type IntervalOption<PpeEvent extends string> = keyof Pick<
    ToFinishWithOptions<PpeEvent>,
    | 'datasetItemCount'
    | 'requestsRetries'
    | 'failedRequests'
    | 'duration'
>

export type ToFinishWithOptions<PpeEvent extends string> = Partial<ToFinishWithOptionsWithDefaults> & {
    datasetItemCount: Interval
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
    chargedEventCounts?: Record<PpeEvent, Interval>
};

export type SdkCrawlerStatistics = {
    requestsFinished: number
    requestsFailed: number
    requestsRetries: number
    requestsFailedPerMinute: number
    requestsFinishedPerMinute: number
    requestMinDurationMillis: number
    requestMaxDurationMillis: number
    requestRetryHistogram: number[]
    requestTotalFailedDurationMillis: number
    requestTotalFinishedDurationMillis: number
    crawlerStartedAt: string
    crawlerFinishedAt: string
    statsPersistedAt: string
    crawlerRuntimeMillis: number
    crawlerLastStartTimestamp: number
}

export type RunStatus =
    | 'SUCCEEDED'
    | 'READY'
    | 'RUNNING'
    | 'FAILED'
    | 'ABORTING'
    | 'ABORTED'
    | 'TIMING-OUT'
    | 'TIMED-OUT'

export interface ActorMatchers<R = unknown> {
    toBeArray: () => R
    toBeBoolean: () => R
    toBeEmptyArray: () => R
    toBeNonEmptyArray: () => R
    toBeNonEmptyString: () => R
    toBeNumber: () => R
    toBeFalse: () => R
    toBeTrue: () => R
    toBeNonEmptyObject: () => R
    toBeObject: () => R
    toBeString: () => R
    toBeWholeNumber: () => R
    toBeWithinRange: (lower: number, upper: number) => R
    /**
     * Validates the following properties of a run:
     * - `status` (default: `SUCCEEDED`)
     * - `duration` in milliseconds (default: `{ min: 600, max: 600_000}` - <0.6s, 10min>)
     * - `failedRequests` (default: `0`)
     * - `requestsRetries` (default: `{ max: 3 }`)
     * - `forbiddenLogs` (default: `['ReferenceError', 'TypeError']`)
     * - `datasetItemCount` (required)
     * - `chargedEventCounts`
     */
    toFinishWith: <PpeEvent extends string>(options: ToFinishWithOptions<PpeEvent>) => Promise<R>
    toStartWith: (prefix: string) => R
    hard: <T>(actual: T, message?: string) => Assertion
}

declare module 'vitest' {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    interface Assertion<T = any> extends ActorMatchers<T> { }
    interface AsymmetricMatchersContaining extends ActorMatchers { }
}
