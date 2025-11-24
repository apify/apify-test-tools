import type { Assertion, ExpectStatic } from 'vitest';

import { TO_FINISH_WITH_OPTIONS } from './consts.js';
import type { Interval, ToFinishWithOptions } from './types';
import { RunTestResult } from './run-test-result.js';

export const extendExpect = (expect: ExpectStatic): ExpectStatic => {
    expect.extend({
        toBeArray: (actual) => {
            const pass = Array.isArray(actual);
            return {
                pass,
                message: () => `Expected "${actual}" to be a array`,
            };
        },
        toBeBoolean: (received) => {
            const actual = typeof received;
            const expected = 'boolean';
            return {
                pass: actual === expected,
                message: () => `Expected "${actual}" to be a boolean`,
                expected: 'boolean',
            };
        },
        toBeEmptyArray: (actual) => {
            const pass = Array.isArray(actual) && actual.length === 0;
            return {
                pass,
                message: () => `Expected ${actual} to be an empty array`,
                actual,
                expected: [],
            };
        },
        toBeNonEmptyArray: (actual) => {
            const pass = Array.isArray(actual) && actual.length > 0;
            return {
                pass,
                message: () => `Expected ${actual} to be a non-empty array`,
            };
        },
        toBeNonEmptyString: (actual) => {
            const pass = typeof actual === 'string' && actual.length > 0;
            return {
                pass,
                message: () => `Expected "${actual}" to be a non-empty string`,
            };
        },
        toBeNumber: (actual) => {
            const pass = typeof actual === 'number';
            return {
                pass,
                message: () => `Expected "${actual}" to be a number`,
            };
        },
        toBeNonEmptyObject: (actual) => {
            const isObject = typeof actual === 'object' && !Array.isArray(actual);
            const isNonEmpty = Object.entries(actual).length > 0;
            const pass = isObject && isNonEmpty;
            return {
                pass,
                message: () => `Expected "${actual}" to be a non-emtpy object`,
            };
        },
        toBeObject: (actual) => {
            const pass = typeof actual === 'object' && !Array.isArray(actual);
            return {
                pass,
                message: () => `Expected "${actual}" to be an object`,
            };
        },
        toBeString: (received) => {
            const actual = typeof received;
            const expected = 'string';
            return {
                pass: actual === expected,
                message: () => `Expected "${actual}" to be a string`,
                actual,
                expected,
            };
        },
        toBeTrue: (actual) => {
            const pass = actual === true;
            return {
                pass,
                message: () => `Expected "${actual}" to be true`,
                expected: true,
                actual,
            };
        },
        toBeFalse: (actual) => {
            const pass = actual === false;
            return {
                pass,
                message: () => `Expected "${actual}" to be false`,
            };
        },
        toBeWholeNumber: (received) => {
            const pass = Number.isInteger(received);
            return {
                pass,
                message: () => `Expected "${received}" to be a whole number`,
            };
        },
        toBeWithinRange: (received, lower, upper) => {
            const pass = received >= lower && received <= upper;
            return {
                pass,
                message: () => `Expected ${received} to be within range <${lower}, ${upper}>`,
            };
        },
        toFinishWith: async <PpeEvent extends string>(
            received: RunTestResult,
            userOptions: ToFinishWithOptions<PpeEvent>,
        ) => {
            const options = {
                ...TO_FINISH_WITH_OPTIONS,
                ...userOptions,
            };

            const diffs: Diffs = {
                pass: true,
                actual: ['Run:'],
                expected: ['Run:'],
            };
            {
                const expected = options?.status;
                const actual = received.status;
                diffs.pass = expected === actual;
                diffs.actual.push(`status=${actual}`);
                diffs.expected.push(`status=${expected}`);
            }

            const {
                chargedEventCounts,
                stats: { durationMillis },
            } = await received.getRunInfo();
            const datasetItemCount = (await received.getDataset()).items.length;
            const stats = (await received.getStatistics());

            isWithinInterval(diffs, datasetItemCount, options, 'datasetItemCount');
            isWithinInterval(diffs, durationMillis, options, 'duration');
            isWithinInterval(diffs, stats?.requestsFailed, options, 'failedRequests');
            isWithinInterval(diffs, stats?.requestsRetries, options, 'requestsRetries');

            const ppeDiffs: Diffs = {
                pass: true,
                actual: ['PPE Events:'],
                expected: ['PPE Events:'],
            };

            if (options.chargedEventCounts) {
                const expected = options.chargedEventCounts;
                const actual = chargedEventCounts ?? {};
                const uniquePpeEvents = new Set([
                    ...Array.from(Object.keys(expected)),
                    ...Array.from(Object.keys(actual)),
                ]);

                for (const ppeEvent of uniquePpeEvents) {
                    if (!(ppeEvent in expected)) {
                        isWithinInterval(
                            ppeDiffs,
                            actual[ppeEvent],
                            { [ppeEvent]: 0 },
                            ppeEvent,
                        );
                        continue;
                    }
                    if (!(ppeEvent in actual)) {
                        ppeDiffs.pass = false;
                        ppeDiffs.actual.push(`${ppeEvent}=X`);
                        ppeDiffs.expected.push(`${ppeEvent}=${expected[ppeEvent as PpeEvent]}`);
                        continue;
                    }
                    isWithinInterval(ppeDiffs, actual[ppeEvent], expected, ppeEvent as PpeEvent);
                }

                diffs.pass = diffs.pass && ppeDiffs.pass;
                diffs.actual.push(ppeDiffs.actual.join('\n    '));
                diffs.expected.push(ppeDiffs.expected.join('\n    '));
            }

            {
                const { forbiddenLogs } = options;
                const log = await received.getLog();
                const occuredLogs = [];
                for (const forbiddenLog of forbiddenLogs) {
                    if (log.includes(forbiddenLog)) {
                        occuredLogs.push(forbiddenLog);
                    }
                }
                if (occuredLogs.length > 0) {
                    diffs.pass = false;
                    diffs.actual.push(` logs=[${occuredLogs.join(', ')}]`);
                    diffs.expected.push(` logs=[]`);
                }
            }

            if (options.maxRetriesPerRequest !== null) {
                const { maxRetriesPerRequest } = options;
                const maxRetriesObserved = (stats?.requestRetryHistogram ?? [0]).length - 1;
                if (maxRetriesObserved > maxRetriesPerRequest) {
                    diffs.pass = false;
                    diffs.actual.push(`maxRetriesPerRequest=${maxRetriesObserved}`);
                    diffs.expected.push(`maxRetriesPerRequest=${maxRetriesPerRequest}`);
                }
            }

            return {
                pass: diffs.pass,
                message: () => `Run ${received.id} didn't finish as expected`,
                actual: diffs.actual.join('\n  '),
                expected: diffs.expected.join('\n  '),
            };
        },
        toStartWith: (received, prefix) => {
            const pass = received?.startsWith(prefix);
            return {
                pass,
                message: () => `Expected "${received}" to start with "${prefix}"`,
            };
        },
    });

    // here we are switching logic of expect and expect.soft
    // expect => expect.soft
    // expect.hard => expect
    const { soft } = expect;
    const oldExpect = { ...expect };
    const softExpect = <T>(actual: T, message?: string): Assertion => {
        return soft(actual, message);
    };

    for (const [key, value] of Object.entries(oldExpect)) {
        // @ts-expect-error: No idea how to type this properly
        softExpect[key] = value;
    }

    softExpect.hard = <T>(actual: T, message?: string): Assertion<T> => {
        return expect(actual, message);
    };

    return softExpect as unknown as ExpectStatic;
};

type Diffs = {
    pass: boolean
    actual: string[]
    expected: string[]

}

const isWithinInterval = <T extends string>(
    diffs: Diffs,
    actual: number | undefined,
    options: Record<T, Interval | null>,
    intervalOption: T,
) => {
    const expected = options[intervalOption];
    if (expected === null) {
        // check is disabled if expected value is null
        return;
    }
    if (typeof expected === 'number') {
        if (actual !== expected) {
            diffs.pass = false;
            diffs.actual.push(`${intervalOption}=${actual}`);
            diffs.expected.push(`${intervalOption}=${expected}`);
        }
    } else if (typeof expected === 'object') {
        const { min, max } = expected;
        if (actual === undefined || (min !== undefined && actual < min) || (max !== undefined && actual > max)) {
            diffs.pass = false;
            diffs.actual.push(`${intervalOption}=${actual}`);
            diffs.expected.push(`${intervalOption}=<${min ?? ''},${max ?? ''}>`);
        }
    }
};
