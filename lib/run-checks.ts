import { TO_FINISH_WITH_OPTIONS } from './consts.js';
import type { RunTestResult } from './run-test-result.js';
import type { Interval, ToFinishWithOptions } from './types.js';

type Check = {
    name: string;
    pass: boolean;
    actual: string;
    expected: string;
};

const isWithinInterval = (actual: number | undefined, interval: Interval): boolean => {
    if (typeof interval === 'number') {
        return actual === interval;
    }
    const { min, max } = interval;
    return actual !== undefined && (min === undefined || actual >= min) && (max === undefined || actual <= max);
};

const describeInterval = (interval: Interval): string => {
    return typeof interval === 'number' ? `${interval}` : `<${interval.min ?? ''},${interval.max ?? ''}>`;
};

const intervalCheck = (name: string, actual: number | undefined, interval: Interval | null): Check[] => {
    // a `null` interval disables the check
    if (interval === null) {
        return [];
    }
    return [
        {
            name,
            pass: isWithinInterval(actual, interval),
            actual: `${actual}`,
            expected: describeInterval(interval),
        },
    ];
};

const ppeChecks = (expected: Record<string, Interval>, actual: Record<string, number> = {}): Check[] => {
    const events = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...events].flatMap((event): Check[] => {
        const name = `chargedEventCounts.${event}`;
        // charged events the test didn't list are expected to not happen at all
        if (!(event in expected)) {
            return intervalCheck(name, actual[event], 0);
        }
        // an expected event that was never charged is a failure, even for an interval that includes 0
        if (!(event in actual)) {
            return [{ name, pass: false, actual: 'X', expected: describeInterval(expected[event]) }];
        }
        return intervalCheck(name, actual[event], expected[event]);
    });
};

/**
 * Evaluates every `toFinishWith` expectation against the run, so a failing assertion reports all of them at once.
 */
export const checkRun = async <PpeEvent extends string>(
    run: RunTestResult,
    userOptions: ToFinishWithOptions<PpeEvent>,
): Promise<Check[]> => {
    const options = { ...TO_FINISH_WITH_OPTIONS, ...userOptions };

    const [runInfo, datasetItemCount, stats, log] = await Promise.all([
        run.getRunInfo(),
        run.getDatasetItemCount(),
        run.getStatistics(),
        run.getLog(),
    ]);

    // the histogram has one bucket per retry count, so its length - 1 is the most retries any request needed
    const maxRetriesPerRequest = (stats?.requestRetryHistogram ?? [0]).length - 1;
    const occurredLogs = options.forbiddenLogs.filter((forbidden) => log.includes(forbidden));

    return [
        { name: 'status', pass: run.status === options.status, actual: run.status, expected: options.status },
        ...intervalCheck('datasetItemCount', datasetItemCount, options.datasetItemCount),
        ...intervalCheck('duration', runInfo.stats.durationMillis, options.duration),
        ...intervalCheck('failedRequests', stats?.requestsFailed, options.failedRequests),
        ...intervalCheck('requestsRetries', stats?.requestsRetries, options.requestsRetries),
        ...(options.maxRetriesPerRequest === null
            ? []
            : [
                  {
                      name: 'maxRetriesPerRequest',
                      pass: maxRetriesPerRequest <= options.maxRetriesPerRequest,
                      actual: `${maxRetriesPerRequest}`,
                      expected: `<=${options.maxRetriesPerRequest}`,
                  },
              ]),
        ...(options.chargedEventCounts ? ppeChecks(options.chargedEventCounts, runInfo.chargedEventCounts) : []),
        {
            name: 'forbiddenLogs',
            pass: occurredLogs.length === 0,
            actual: `[${occurredLogs.join(', ')}]`,
            expected: '[]',
        },
    ];
};
