import { STATISTICS_KEY_PREFIXES, TO_FINISH_WITH_OPTIONS } from './consts.js';
import { MissingStatisticsError } from './missing-statistics-error.js';
import type { RunTestResult } from './run-test-result.js';
import type { CrawlerStatistics, Interval, ToFinishWithOptions, ToFinishWithOptionsWithDefaults } from './types.js';

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

/**
 * Only the listed events are checked, and an event that was never charged counts as 0, so `0` asserts it wasn't.
 * Strict, any charged event that isn't listed must not have happened either.
 */
const ppeChecks = (
    expected: Record<string, Interval>,
    charged: Record<string, number> | undefined,
    strict: boolean,
): Check[] => {
    const actual = charged ?? {};
    const events = new Set([...Object.keys(expected), ...(strict ? Object.keys(actual) : [])]);
    return [...events].flatMap((event) =>
        intervalCheck(`chargedEventCounts.${event}`, actual[event] ?? 0, expected[event] ?? 0),
    );
};

/** At most this many offending log lines are quoted in a failed check, each cut to `MAX_LOG_LINE_LENGTH` */
const MAX_QUOTED_LOG_LINES = 3;
const MAX_LOG_LINE_LENGTH = 200;

const describeForbidden = (forbidden: string | RegExp) =>
    typeof forbidden === 'string' ? JSON.stringify(forbidden) : `${forbidden}`;

/** A string in, or a regular expression matching, any line of the log */
const forbiddenLogsCheck = (log: string, forbiddenLogs: (string | RegExp)[]): Check => {
    const lines = log.split('\n');
    const offending = lines.filter((line) =>
        forbiddenLogs.some((forbidden) =>
            typeof forbidden === 'string' ? line.includes(forbidden) : new RegExp(forbidden).test(line),
        ),
    );
    const quoted = offending.slice(0, MAX_QUOTED_LOG_LINES).map((line) => line.trim().slice(0, MAX_LOG_LINE_LENGTH));
    const more = offending.length > MAX_QUOTED_LOG_LINES ? ` and ${offending.length - MAX_QUOTED_LOG_LINES} more` : '';
    return {
        name: 'forbiddenLogs',
        pass: quoted.length === 0,
        actual: quoted.length === 0 ? '[]' : `[${quoted.join(' | ')}]${more}`,
        expected: `none of [${forbiddenLogs.map(describeForbidden).join(', ')}]`,
    };
};

const statisticsChecks = async (run: RunTestResult, options: ToFinishWithOptionsWithDefaults): Promise<Check[]> => {
    const { failedRequests, requestsRetries, maxRetriesPerRequest } = options;
    const wanted = [
        ['failedRequests', failedRequests],
        ['requestsRetries', requestsRetries],
        ['maxRetriesPerRequest', maxRetriesPerRequest],
    ].filter(([, expected]) => expected != null) as [string, Interval][];
    // Fetched only for the checks that need them, so an Actor without statistics can skip them all
    if (wanted.length === 0) return [];

    let statistics: CrawlerStatistics | undefined;
    let missing = STATISTICS_KEY_PREFIXES.map((prefix) => `${prefix}*`).join(' or ');
    try {
        statistics = await run.getStatistics(options.statisticsKeys);
    } catch (error) {
        if (!(error instanceof MissingStatisticsError)) throw error;
        missing = error.keys.join(', ');
    }
    if (!statistics) {
        const actual = `no statistics record ${missing}`;
        return wanted.map(([name, expected]) => ({
            name,
            pass: false,
            actual,
            expected: name === 'maxRetriesPerRequest' ? `<=${expected}` : describeInterval(expected),
        }));
    }
    return [
        ...intervalCheck('failedRequests', statistics.requestsFailed, failedRequests),
        ...intervalCheck('requestsRetries', statistics.requestsRetries, requestsRetries),
        ...(maxRetriesPerRequest == null
            ? []
            : [
                  {
                      name: 'maxRetriesPerRequest',
                      pass: statistics.maxRetriesPerRequest <= maxRetriesPerRequest,
                      actual: `${statistics.maxRetriesPerRequest}`,
                      expected: `<=${maxRetriesPerRequest}`,
                  },
              ]),
    ];
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
    const [runInfo, { items }, log, statistics] = await Promise.all([
        run.getRunInfo(),
        run.getDataset(),
        run.getLog(),
        statisticsChecks(run, options),
    ]);

    return [
        { name: 'status', pass: run.status === options.status, actual: run.status, expected: options.status },
        ...intervalCheck('datasetItemCount', items.length, options.datasetItemCount),
        ...intervalCheck('duration', runInfo.stats.durationMillis, options.duration),
        ...statistics,
        ...(options.chargedEventCounts
            ? ppeChecks(options.chargedEventCounts, runInfo.chargedEventCounts, options.strictChargedEventCounts)
            : []),
        forbiddenLogsCheck(log, options.forbiddenLogs),
    ];
};
