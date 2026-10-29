import { inspect } from 'node:util';

import type { Assertion, ExpectStatic } from 'vitest';

import { checkRun } from './run-checks.js';
import type { RunTestResult } from './run-test-result.js';
import type { ToFinishWithOptions } from './types.js';

/** Matchers that only check the type or shape of a value. */
const SHAPE_MATCHERS = {
    toBeArray: ['an array', (actual: unknown) => Array.isArray(actual)],
    toBeBoolean: ['a boolean', (actual: unknown) => typeof actual === 'boolean'],
    toBeEmptyArray: ['an empty array', (actual: unknown) => Array.isArray(actual) && actual.length === 0],
    toBeNonEmptyArray: ['a non-empty array', (actual: unknown) => Array.isArray(actual) && actual.length > 0],
    toBeNonEmptyString: ['a non-empty string', (actual: unknown) => typeof actual === 'string' && actual.length > 0],
    toBeNumber: ['a number', (actual: unknown) => typeof actual === 'number'],
    toBeFalse: ['false', (actual: unknown) => actual === false],
    toBeTrue: ['true', (actual: unknown) => actual === true],
    toBeNonEmptyObject: ['a non-empty object', (actual: unknown) => isObject(actual) && Object.keys(actual).length > 0],
    toBeObject: ['an object', isObject],
    toBeString: ['a string', (actual: unknown) => typeof actual === 'string'],
    toBeWholeNumber: ['a whole number', (actual: unknown) => Number.isInteger(actual)],
} as const satisfies Record<string, readonly [string, (actual: unknown) => boolean]>;

function isObject(actual: unknown): actual is object {
    return typeof actual === 'object' && !Array.isArray(actual) && actual !== null;
}

const shapeMatchers = Object.fromEntries(
    Object.entries(SHAPE_MATCHERS).map(([name, [description, predicate]]) => [
        name,
        (actual: unknown) => ({
            pass: predicate(actual),
            message: () => `Expected ${inspect(actual)} to be ${description}`,
            actual,
        }),
    ]),
);

export const extendExpect = (expect: ExpectStatic): ExpectStatic => {
    expect.extend({
        ...shapeMatchers,
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
            const checks = await checkRun(received, userOptions);
            const failed = checks.filter(({ pass }) => !pass);
            return {
                pass: failed.length === 0,
                message: () =>
                    `Run did not finish as expected. Failed assertions: ${failed
                        .map(
                            ({ name, expected, actual }) =>
                                `Failed ${name} check, expected ${expected}, got ${actual}.`,
                        )
                        .join(' ')}`,
                actual: ['Run:', ...failed.map(({ name, actual }) => `${name}=${actual}`)].join('\n  '),
                expected: ['Run:', ...failed.map(({ name, expected }) => `${name}=${expected}`)].join('\n  '),
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
