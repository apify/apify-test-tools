import { ApifyClient } from 'apify';
import {
    describe as vitestDescribe,
    ExpectStatic,
    TestFunction,
    test as vitestTest,
    SuiteFactory,
    TestOptions,
    TestContext,
} from 'vitest';
import type { ActorBuild, RunOptions } from './types';
import { RunTestResult } from './run-test-result.js';
import { extendExpect } from './extend-expect.js';
import { getActorPrefilledInput } from './utils.js';

const ACTOR_BUILDS = 'ACTOR_BUILDS';
let actorBuilds: ActorBuild[] = [];
try {
    const actorBuildsEnv = process.env[ACTOR_BUILDS];
    if (actorBuildsEnv) {
        actorBuilds = JSON.parse(actorBuildsEnv);
        if (!Array.isArray(actorBuilds)) {
            throw new Error(`${ACTOR_BUILDS} env variable should contain a JSON array, got ${typeof actorBuilds}`);
        }
    }
} catch (err) {
    throw new Error(`Failed to parse actor builds: ${err}`);
}

const config = actorBuilds.reduce((map, cfg) => {
    map.set(cfg.actorName, cfg);
    map.set(cfg.actorId, cfg);
    return map;
}, new Map<string, ActorBuild>());

export { ExpectStatic };

const { TESTER_APIFY_TOKEN, RUN_PLATFORM_TESTS, RUN_ALL_PLATFORM_TESTS } = process.env;
const apifyClient = new ApifyClient({ token: TESTER_APIFY_TOKEN });

const DEFAULT_TEST_OPTIONS: TestOptions = {
    // we want to run tests concurrently
    concurrent: true,
    // test should finish within 1 hour
    timeout: 60_000 * 60,
};

export const describe = (
    name: string,
    fn?: SuiteFactory<object>,
    options: TestOptions = DEFAULT_TEST_OPTIONS,
) => {
    vitestDescribe.runIf(!!RUN_PLATFORM_TESTS || !!RUN_ALL_PLATFORM_TESTS)(name, options, fn);
};

const DEFAULT_TEST_ACTOR_OPTIONS: TestOptions = {
    retry: 1,
};

export const testActor = <T>(
    actorName: string,
    testName: string,
    fn: TestFunction<{ run: ReturnType<typeof createStartRunFn<T>> }>,
    testOptions?: TestOptions,
) => {
    const options = {
        ...DEFAULT_TEST_ACTOR_OPTIONS,
        ...testOptions,
    };
    const name = `${actorName}: ${testName}`;
    const shouldRun = !!RUN_ALL_PLATFORM_TESTS || config.has(actorName);

    vitestTest.runIf(shouldRun)(name, options, async (context) => {
        const { expect, ...rest } = context;
        await fn({
            expect: extendExpect(expect),
            run: createStartRunFn(actorName, context),
            ...rest,
        });
    });
};

export const testTestActor = <T>(
    testName: string,
    fn: TestFunction<{ run: ReturnType<typeof createStartRunFn<T>> }>,
) => {
    vitestTest(testName, async (context) => {
        const { expect, ...rest } = context;
        await fn({
            expect: extendExpect(expect),
            // @ts-expect-error: this just to test custom matchers
            run: () => { },
            ...rest,
        });
    });
};

export const it = testActor;

const createStartRunFn = <T>(actorNameOrId: string, { annotate, task }: TestContext) => {
    const actorConfig = config.get(actorNameOrId);
    const build = actorConfig?.buildNumber;
    const buildId = actorConfig?.buildId;
    return async (runOptions: RunOptions<T>) => {
        const {
            input,
            options,
            prefilledInput,
        } = runOptions;
        const actor = apifyClient.actor(actorNameOrId);

        const actorInput = {
            ...(prefilledInput && await getActorPrefilledInput(apifyClient, actorNameOrId, buildId)),
            ...input,
        };
        const run = await actor.call(
            actorInput,
            { build, ...options, },
        );

        const runLink = `https://console.apify.com/view/runs/${run.id}`;
        await annotate(runLink, 'run_link');
        // @ts-expect-error: `TaskMeta` cannot be retyped
        task.meta = {
            runId: run.id,
            runLink,
        };

        // waiting for datasetItemCount and chargedEventCounts to sync
        await new Promise((resolve) => setTimeout(resolve, 10_000));

        return new RunTestResult(apifyClient, run);
    };
};
