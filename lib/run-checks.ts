import { TO_FINISH_WITH_OPTIONS } from './consts.js';
import type { RunTestResult } from './run-test-result.js';
import type { Interval, ToFinishWithOptions } from './types.js';
import { sleep } from './utils.js';

const CHARGED_EVENTS_POLL_INTERVAL_MS = 5_000;
const CHARGED_EVENTS_TIMEOUT_MS = 60_000;

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

const intervalCheck = (name: string, actual: number | undefined, interval: Interval | null | undefined): Check[] => {
    // `null` disables the check, and so does an explicit `undefined`, e.g. from a caller forwarding an optional setting
    if (interval == null) {
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
 * The platform reconciles charged events onto the run some time after it finished, even more so when the run hit
 * its charge limit, so keep re-fetching the run until the expected counts show up or the timeout passes. Counts only
 * grow, so one already past its maximum ends the wait. Once the platform's storages become immediately consistent,
 * the first fetch settles this and the loop never runs, so it can stay.
 */
const getRunInfo = async (run: RunTestResult, expected: Record<string, Interval> | undefined) => {
    let runInfo = await run.getRunInfo();
    const intervals = Object.entries(expected ?? {});
    const settled = () =>
        intervals.every(([event, interval]) => isWithinInterval(runInfo.chargedEventCounts?.[event], interval)) ||
        intervals.some(([event, interval]) => {
            const max = typeof interval === 'number' ? interval : interval.max;
            return max !== undefined && (runInfo.chargedEventCounts?.[event] ?? 0) > max;
        });
    for (let waited = 0; !settled() && waited < CHARGED_EVENTS_TIMEOUT_MS; waited += CHARGED_EVENTS_POLL_INTERVAL_MS) {
        await sleep(CHARGED_EVENTS_POLL_INTERVAL_MS);
        runInfo = await run.fetchRunInfo();
    }
    return runInfo;
};

/**
 * Evaluates every `toFinishWith` expectation against the run, so a failing assertion reports all of them at once.
 */
export const checkRun = async <PpeEvent extends string>(
    run: RunTestResult,
    userOptions: ToFinishWithOptions<PpeEvent>,
): Promise<Check[]> => {
    const options = { ...TO_FINISH_WITH_OPTIONS, ...userOptions };

    // The dataset's item count lags the run by 10-20 seconds, so counting the downloaded items is the only way to
    // be in sync. Don't swap it for the count from the dataset info.
    const [runInfo, { items }, stats, log] = await Promise.all([
        getRunInfo(run, options.chargedEventCounts),
        run.getDataset(),
        run.getStatistics(),
        run.getLog(),
    ]);

    // the histogram has one bucket per retry count, so its length - 1 is the most retries any request needed
    const maxRetriesPerRequest = (stats?.requestRetryHistogram ?? [0]).length - 1;
    const occurredLogs = options.forbiddenLogs.filter((forbidden) => log.includes(forbidden));

    return [
        { name: 'status', pass: run.status === options.status, actual: run.status, expected: options.status },
        ...intervalCheck('datasetItemCount', items.length, options.datasetItemCount),
        ...intervalCheck('duration', runInfo.stats.durationMillis, options.duration),
        ...intervalCheck('failedRequests', stats?.requestsFailed, options.failedRequests),
        ...intervalCheck('requestsRetries', stats?.requestsRetries, options.requestsRetries),
        ...(options.maxRetriesPerRequest == null
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
