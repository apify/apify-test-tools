import type { TestFunction, TestOptions } from 'vitest';
import { afterAll, test as vitestTest } from 'vitest';

import { extendExpect } from './extend-expect.js';
import { createHarness, type Harness, type HarnessOptions } from './harness.js';

type HarnessContext = Pick<Harness, 'createActor' | 'runActor'>;

/**
 * `createHarness` bound to the calling test file: builds of its Actors older than three days are pruned after the file's tests. Call
 * at the top level of a test file.
 *
 * The returned `test` is vitest's with `createActor`, `runActor` and the soft, matcher-extended `expect` (see
 * `toFinishWith`) in the test context, like `testActor` does. `createActor` and `runActor` are also returned
 * directly for use in hooks.
 */
export interface VitestHarness extends Pick<Harness, 'createActor' | 'runActor'> {
    /** vitest's `test` with `createActor`, `runActor` and the soft, matcher-extended `expect` in its context. */
    test: HarnessTest;
}

type HarnessTestFn = (name: string, fn: TestFunction<HarnessContext>, options?: TestOptions) => void;
interface HarnessTest extends HarnessTestFn {
    skip: HarnessTestFn;
    only: HarnessTestFn;
    skipIf(condition: unknown): HarnessTestFn;
}

export const useHarness = (options: HarnessOptions): VitestHarness => {
    const { createActor, runActor, cleanup } = createHarness(options);
    afterAll(cleanup);

    const define =
        (runner: (name: string, options: TestOptions, fn: TestFunction) => void) =>
        (name: string, fn: TestFunction<HarnessContext>, testOptions?: TestOptions) => {
            runner(name, testOptions ?? {}, async (context) => {
                await fn({ ...context, expect: extendExpect(context.expect), createActor, runActor });
            });
        };
    const test = Object.assign(define(vitestTest), {
        skip: define(vitestTest.skip),
        only: define(vitestTest.only),
        skipIf: (condition: unknown) => define(vitestTest.skipIf(condition)),
    });

    return { test, createActor, runActor };
};
