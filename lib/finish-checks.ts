import { TO_FINISH_WITH_OPTIONS } from './consts.js';
import type { RunTestResult } from './run-test-result.js';
import type { Interval, ToFinishWithOptions } from './types.js';

/** One thing `toFinishWith` verifies about a run. */
type FinishCheck = {
    ok: boolean;
    /** `name=value` lines for the actual and the expected side of the failure diff. */
    actual: string;
    expected: string;
    /** Sentence for the failure message. */
    failure: string;
};

const describeInterval = (interval: Interval): string =>
    typeof interval === 'number' ? `${interval}` : `<${interval.min ?? ''},${interval.max ?? ''}>`;

const isWithinInterval = (actual: number | undefined, interval: Interval): boolean => {
    if (typeof interval === 'number') return actual === interval;
    const { min, max } = interval;
    return actual !== undefined && (min === undefined || actual >= min) && (max === undefined || actual <= max);
};

const intervalCheck = (name: string, label: string, actual: number | undefined, expected: Interval): FinishCheck => ({
    ok: isWithinInterval(actual, expected),
    actual: `${name}=${actual}`,
    expected: `${name}=${describeInterval(expected)}`,
    failure: `Failed ${label} check, expected ${JSON.stringify(expected)}, got ${actual}.`,
});

/**
 * Collects every check `toFinishWith` makes on a run. A check set to `null` (or an explicit `undefined`, e.g. from a
 * caller forwarding an optional setting) is disabled and left out.
 */
export const getFinishChecks = async <PpeEvent extends string>(
    run: RunTestResult,
    userOptions: ToFinishWithOptions<PpeEvent>,
): Promise<FinishCheck[]> => {
    const options = { ...TO_FINISH_WITH_OPTIONS, ...userOptions };
    const { forbiddenLogs, maxRetriesPerRequest, chargedEventCounts: expectedEvents } = options;

    // The dataset's item count lags the run by 10-20 seconds, so counting the downloaded items is the only way to
    // be in sync. Don't swap it for the count from the dataset info.
    const [runInfo, { items }, stats, log] = await Promise.all([
        run.getRunInfo(),
        run.getDataset(),
        run.getStatistics(),
        forbiddenLogs.length > 0 ? run.getLog() : '',
    ]);

    const checks: FinishCheck[] = [
        {
            ok: run.status === options.status,
            actual: `status=${run.status}`,
            expected: `status=${options.status}`,
            failure: `Failed status check, expected "${options.status}", got "${run.status}".`,
        },
    ];

    const intervals: [
        name: string,
        label: string,
        actual: number | undefined,
        expected: Interval | null | undefined,
    ][] = [
        ['datasetItemCount', 'dataset item count', items.length, options.datasetItemCount],
        ['duration', 'duration', runInfo.stats.durationMillis, options.duration],
        ['failedRequests', 'failed requests', stats?.requestsFailed, options.failedRequests],
        ['requestsRetries', 'requests retries', stats?.requestsRetries, options.requestsRetries],
    ];
    for (const [name, label, actual, expected] of intervals) {
        if (expected != null) checks.push(intervalCheck(name, label, actual, expected));
    }

    if (maxRetriesPerRequest != null) {
        const observed = (stats?.requestRetryHistogram ?? [0]).length - 1;
        checks.push({
            ok: observed <= maxRetriesPerRequest,
            actual: `maxRetriesPerRequest=${observed}`,
            expected: `maxRetriesPerRequest<=${maxRetriesPerRequest}`,
            failure: `Failed max retries observed check, expected <=${maxRetriesPerRequest}, got ${observed}.`,
        });
    }

    if (expectedEvents) {
        const actualEvents: Record<string, number> = runInfo.chargedEventCounts ?? {};
        const eventNames = new Set([...Object.keys(expectedEvents), ...Object.keys(actualEvents)]);
        for (const event of eventNames) {
            // An event we didn't list is expected to never be charged
            const expected: Interval = (expectedEvents as Record<string, Interval>)[event] ?? 0;
            const actual = actualEvents[event];
            const name = `chargedEventCounts[${event}]`;
            // A listed event that was never charged has no count to compare, so it can't satisfy any interval
            const check = intervalCheck(name, `charged event "${event}"`, actual, expected);
            checks.push(actual === undefined ? { ...check, ok: false, actual: `${name}=X` } : check);
        }
    }

    const occurred = forbiddenLogs.filter((forbidden) => log.includes(forbidden));
    checks.push({
        ok: occurred.length === 0,
        actual: `logs=[${occurred.join(', ')}]`,
        expected: 'logs=[]',
        failure: `Failed forbidden logs check, expected [] but got [${occurred.join(', ')}].`,
    });

    return checks;
};
