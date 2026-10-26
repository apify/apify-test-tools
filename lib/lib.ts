import { ApifyClient } from 'apify-client';
import type { SuiteFactory, TestFunction } from 'vitest';
import { describe as vitestDescribe, ExpectStatic } from 'vitest';

import { ActorBuilds } from './actor-builds.js';
import { DEFAULT_TEST_OPTIONS } from './consts.js';
import { defineActorTest } from './define-actor-test.js';
import { createStandbyTask, createStartStandbyFn } from './standby.js';
import { createStartRunFn } from './start-run.js';
import type { ActorTestOptions } from './types.js';

const builds = ActorBuilds.fromEnv();

export { ExpectStatic };

const { TESTER_APIFY_TOKEN, RUN_ALL_PLATFORM_TESTS } = process.env;
const apifyClient = new ApifyClient({ token: TESTER_APIFY_TOKEN });

/**
 * Platform tests need `TESTER_APIFY_TOKEN` to talk to the platform, so without it we skip them altogether.
 *
 * `RUN_ALL_PLATFORM_TESTS` enables them too because locally we can test against a hardcoded `runId`,
 * which doesn't need the tester token.
 */
export const describe = (name: string, fn?: SuiteFactory<object>, options: ActorTestOptions = DEFAULT_TEST_OPTIONS) => {
    vitestDescribe.runIf(!!TESTER_APIFY_TOKEN || !!RUN_ALL_PLATFORM_TESTS)(name, options, fn);
};

// `RUN_ALL_PLATFORM_TESTS` is needed for the scheduled tests, which have no `ACTOR_BUILDS` to match the
// tests against - without it, every test would be filtered out as an Actor we didn't build.
const defineTest = <F extends object>(options: Omit<Parameters<typeof defineActorTest<F>>[0], 'builds' | 'runAll'>) =>
    defineActorTest({ builds, runAll: !!RUN_ALL_PLATFORM_TESTS, ...options });

/**
 * @param actorId - The Actor's raw platform ID or its full name (`owner/name`, e.g. `"apify/web-scraper"`).
 */
export const testActor = <T>(
    actorId: string,
    testName: string,
    fn: TestFunction<{ run: ReturnType<typeof createStartRunFn<T>> }>,
    testOptions?: ActorTestOptions,
) =>
    defineTest({
        actorId,
        testName,
        testOptions,
        setup: (context) => ({ fixtures: { run: createStartRunFn<T>(apifyClient, builds, actorId, context) } }),
        fn,
    });

/**
 * Creates a new task with the specific `build` of the standby Actor and provides the `callStandby` function,
 * which calls the task's `standbyUrl`. The task is deleted when the test ends.
 *
 * Using a task is just a current shortcoming of the standby feature, ideally we would use the Actor directly.
 *
 * @param actorId - The Actor's raw platform ID or its full name (`owner/name`, e.g. `"apify/web-scraper"`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const testStandbyActor = <I = any, O = any>(
    actorId: string,
    testName: string,
    fn: TestFunction<{ callStandby: ReturnType<typeof createStartStandbyFn<I, O>> }>,
    testOptions?: ActorTestOptions,
) =>
    defineTest({
        actorId,
        testName,
        testOptions,
        setup: async (context, name) => {
            const standbyTask = await createStandbyTask(apifyClient, actorId, builds.get(actorId)?.buildNumber);
            return {
                fixtures: { callStandby: createStartStandbyFn<I, O>(apifyClient, standbyTask, context, name) },
                dispose: async () => {
                    const { taskId } = standbyTask;
                    await apifyClient
                        .task(taskId)
                        .delete()
                        .catch((error) => {
                            console.error(`Failed to delete standby task "${taskId}": ${error}`);
                        });
                },
            };
        },
        fn,
    });

export const it = testActor;
