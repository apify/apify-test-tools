import { Actor, ActorRun, ActorRunListItem, ActorStandby, ApifyClient, Task } from 'apify-client';
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
import { getActorPrefilledInput, sleep } from './utils.js';

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

/**
 * This wrapper creates a new task with specific `build` of the standby actor and provides
 * `callStandby` function, which calls the task's `standbyUrl`.
 *
 * Using task is just current shortcoming of standby feature but ideally we would use Actor directly
 */
export const testStandbyActor = <I = any, O = any>(
    actorName: string,
    testName: string,
    fn: TestFunction<{ callStandby: ReturnType<typeof createStartStandbyFn<I, O>> }>,
    testOptions?: TestOptions,
) => {
    const options = {
        ...DEFAULT_TEST_ACTOR_OPTIONS,
        ...testOptions,
    };
    const name = `${actorName}: ${testName}`;
    const shouldRun = !!RUN_ALL_PLATFORM_TESTS || config.has(actorName);

    vitestTest.runIf(shouldRun)(name, options, async (context) => {
        const standbyTask = await createStandbyTask(actorName, config.get(actorName)?.buildNumber);
        const { annotate } = context;
        const { expect, ...rest } = context;

        // NOTE: we need to wrap `fn` in try-catch so that we can always clean up (delete the task) afterwards
        try {
            await fn({
                expect: extendExpect(expect),
                callStandby: createStartStandbyFn(standbyTask),
                ...rest,
            });
        } catch {}

        const { taskId } = standbyTask;
        const runs = (await apifyClient.task(taskId).runs().list()).items
        for (const run of runs) {
            const runLink = generateRunLink(run);
            await annotate(runLink, 'run_link');
        }

        if (taskId) {
            await apifyClient.task(taskId).delete()
        }

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

/**
 * Creates a function the accepts input for a standby actor and sends request containing input
 * to the task's standby url.
 */
const createStartStandbyFn = <I, O>(standbyTask: StandbyTask) => {
    const { standbyUrl } = standbyTask;
    return async ({ input }: Pick<RunOptions<I>, 'input'>) => {
        const response = await fetch(standbyUrl, {
            headers: {
                Authorization: `Bearer ${apifyClient.token}`,
            },
            method: 'POST',
            body: JSON.stringify(input),
        });

        const data = await response.json() as O;
        return {
            data,
            status: response.status,
            headers: response.headers,
        };
    };
}

interface StandbyTask {
    standbyUrl: string;
    taskId: string;
}

/**
 * Creates a task with specific `build` - either `buildNumber` or default.
 *
 * @throws if actor doesn't exist or it doesn't support standby mode.
 */
const createStandbyTask = async (actorNameOrId: string, buildNumber?: string): Promise<StandbyTask> => {
    const actor = apifyClient.actor(actorNameOrId);

    const actorInfo = (await actor.get()) as Actor & { standbyUrl?: string };
    if (!actorInfo) {
        throw new Error(`Actor "${actorNameOrId}" not found`);
    }

    if (!actorInfo.standbyUrl) {
        throw new Error(`Actor "${actorNameOrId}" doesn't support standby mode`);
    }

    if (!actorInfo.actorStandby) {
        throw new Error(`Actor "${actorNameOrId} doesn't contain actorStandby options`);
    }
    const { isEnabled, ...defaultActorStandby } = actorInfo.actorStandby;
    const build = buildNumber ?? defaultActorStandby.build;

    const actorStandbyOptions: ActorStandby = {
        ...defaultActorStandby,
        build,
    }

    try {
        const newTask = await apifyClient.tasks().create({
            actId: actorNameOrId,
            actorStandby: actorStandbyOptions,
            description: `Task for testing standby version ${build}`,
            title: `Test task - ${build}`,
        }) as Task & { standbyUrl?: string };

        const { id, standbyUrl } = newTask;

        if (!standbyUrl) {
            throw new Error(`Task "${id} doesn't contain standbyUrl property`);
        }

        return {
            standbyUrl,
            taskId: id,
        }
    } catch (error) {
        throw new Error(`Failed to create task: ${error}`);
    }
}

const createStartRunFn = <T>(actorNameOrId: string, testContext: TestContext) => {
    const { annotate, task } = testContext;
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

        const runLink = generateRunLink(run);
        await annotate(runLink, 'run_link');
        // @ts-expect-error: `TaskMeta` cannot be retyped
        task.meta = {
            runId: run.id,
            runLink,
            actorName: actorNameOrId,
        };

        // waiting for datasetItemCount and chargedEventCounts to sync
        await sleep(10_000);

        return new RunTestResult(apifyClient, run);
    };
};

const generateRunLink = (run: ActorRun | ActorRunListItem): string => {
    return `https://console.apify.com/view/runs/${run.id}`;
}
