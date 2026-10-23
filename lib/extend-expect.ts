import type { Assertion, ExpectStatic } from 'vitest';

import { getFinishChecks } from './finish-checks.js';
import type { RunTestResult } from './run-test-result.js';
import type { ToFinishWithOptions } from './types.js';

const show = (value: unknown): string => {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
};

const isObject = (value: unknown): value is object =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** A matcher that checks one property of the value, e.g. `toBeString` or `toBeEmptyArray`. */
const predicateMatcher = (description: string, predicate: (actual: unknown) => boolean) => (actual: unknown) => {
    const pass = predicate(actual);
    return { pass, message: () => `Expected ${show(actual)} ${pass ? 'not ' : ''}to be ${description}` };
};

export const extendExpect = (expect: ExpectStatic): ExpectStatic => {
    expect.extend({
        toBeArray: predicateMatcher('an array', Array.isArray),
        toBeBoolean: predicateMatcher('a boolean', (actual) => typeof actual === 'boolean'),
        toBeEmptyArray: predicateMatcher('an empty array', (actual) => Array.isArray(actual) && actual.length === 0),
        toBeNonEmptyArray: predicateMatcher(
            'a non-empty array',
            (actual) => Array.isArray(actual) && actual.length > 0,
        ),
        toBeNonEmptyString: predicateMatcher(
            'a non-empty string',
            (actual) => typeof actual === 'string' && actual.length > 0,
        ),
        toBeNumber: predicateMatcher('a number', (actual) => typeof actual === 'number'),
        toBeNonEmptyObject: predicateMatcher(
            'a non-empty object',
            (actual) => isObject(actual) && Object.keys(actual).length > 0,
        ),
        toBeObject: predicateMatcher('an object', isObject),
        toBeString: predicateMatcher('a string', (actual) => typeof actual === 'string'),
        toBeTrue: predicateMatcher('true', (actual) => actual === true),
        toBeFalse: predicateMatcher('false', (actual) => actual === false),
        toBeWholeNumber: predicateMatcher('a whole number', Number.isInteger),
        toBeWithinRange: (received, lower, upper) => {
            const pass = received >= lower && received <= upper;
            return {
                pass,
                message: () => `Expected ${received} ${pass ? 'not ' : ''}to be within range <${lower}, ${upper}>`,
            };
        },
        toFinishWith: async <PpeEvent extends string>(
            received: RunTestResult,
            userOptions: ToFinishWithOptions<PpeEvent>,
        ) => {
            const failed = (await getFinishChecks(received, userOptions)).filter((check) => !check.ok);
            return {
                pass: failed.length === 0,
                message: () =>
                    `Run did not finish as expected. Failed assertions: ${failed.map((check) => check.failure).join(' ')}`,
                actual: ['Run:', ...failed.map((check) => check.actual)].join('\n  '),
                expected: ['Run:', ...failed.map((check) => check.expected)].join('\n  '),
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
