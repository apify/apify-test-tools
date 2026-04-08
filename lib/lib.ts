import type { Actor, ActorRun, ActorRunListItem, ActorStandby, Task } from 'apify-client';
import { ApifyClient } from 'apify-client';
import type { SuiteFactory, TestContext, TestFunction } from 'vitest';
import { describe as vitestDescribe, ExpectStatic, test as vitestTest } from 'vitest';

import { extendExpect } from './extend-expect.js';
import { RunTestResult } from './run-test-result.js';
import type { ActorBuild, ActorTestOptions, RunOptions } from './types.js';
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

const config = actorBuilds.reduce<Map<string, ActorBuild>>((map, cfg) => {
    map.set(cfg.actorName, cfg);
    map.set(cfg.actorId, cfg);
    return map;
}, new Map<string, ActorBuild>());

export { ExpectStatic };

const { TESTER_APIFY_TOKEN, RUN_PLATFORM_TESTS, RUN_ALL_PLATFORM_TESTS } = process.env;
const apifyClient = new ApifyClient({ token: TESTER_APIFY_TOKEN });

const DEFAULT_TEST_OPTIONS: ActorTestOptions = {
    // we want to run tests concurrently
    concurrent: true,
    // test should finish within 1 hour
    timeout: 60_000 * 60,
};

export const describe = (name: string, fn?: SuiteFactory<object>, options: ActorTestOptions = DEFAULT_TEST_OPTIONS) => {
    vitestDescribe.runIf(!!RUN_PLATFORM_TESTS || !!RUN_ALL_PLATFORM_TESTS)(name, options, fn);
};

const DEFAULT_TEST_ACTOR_OPTIONS: ActorTestOptions = {
    retry: 1,
};

export const testActor = <T>(
    actorName: string,
    testName: string,
    fn: TestFunction<{ run: ReturnType<typeof createStartRunFn<T>> }>,
    testOptions?: ActorTestOptions,
) => {
    const options = {
        ...DEFAULT_TEST_ACTOR_OPTIONS,
        ...testOptions,
    };
    const name = `${actorName}: ${testName}`;
    const shouldRun = !!RUN_ALL_PLATFORM_TESTS || config.has(actorName);
    vitestTest.runIf(shouldRun)(name, options, async <TYPE extends TestContext>(context: TYPE) => {
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const testStandbyActor = <I = any, O = any>(
    actorName: string,
    testName: string,
    fn: TestFunction<{ callStandby: ReturnType<typeof createStartStandbyFn<I, O>> }>,
    testOptions?: ActorTestOptions,
) => {
    const options = {
        ...DEFAULT_TEST_ACTOR_OPTIONS,
        ...testOptions,
    };
    const name = `${actorName}: ${testName}`;
    const shouldRun = !!RUN_ALL_PLATFORM_TESTS || config.has(actorName);

    vitestTest.runIf(shouldRun)(name, options, async <T extends TestContext>(context: T) => {
        const standbyTask = await createStandbyTask(actorName, config.get(actorName)?.buildNumber);
        const { expect, ...rest } = context;

        // NOTE: we wrap `fn` in try/finally so cleanup (deleting the task) always runs afterwards
        try {
            await fn({
                expect: extendExpect(expect),
                callStandby: createStartStandbyFn(standbyTask, context, name),
                ...rest,
            });
        } finally {
            // we want to delete the task at the end of the test
            await apifyClient.task(standbyTask.taskId).delete();
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
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            run: () => { },
            ...rest,
        });
    });
};

export const it = testActor;

/**
 * Creates a function that accepts input for a standby actor and sends a request containing the input
 * to the task's standby url.
 */
const createStartStandbyFn = <I, O>(standbyTask: StandbyTask, { annotate }: TestContext, testName: string) => {
    const { standbyUrl, taskId } = standbyTask;
    const annotatedRuns = new Set<string>();

    // We annotate all the runs of the task, though it will be only one run
    // for most of the tests. To avoid annotating the same run multiple times
    // (in case the test calls the standby more than once), we use `annotatedRuns`
    // set to keep track of which runs have already been annotated.
    const annotateStandbyRuns = async () => {
        const runs = (await apifyClient.task(taskId).runs().list()).items;
        for (const run of runs) {
            if (!annotatedRuns.has(run.id)) {
                const runLink = generateRunLink(run);
                await annotate(`${testName} - ${runLink}`, 'run_link');
            }
            annotatedRuns.add(run.id);
        }
    };

    return async ({
        input,
        path = '',
        headers = {},
    }: Pick<RunOptions<I>, 'input'> & { path?: string; headers?: Record<string, string> }) => {
        const response = await fetch(standbyUrl + path, {
            headers: {
                ...headers,
                Authorization: `Bearer ${apifyClient.token}`,
            },
            method: 'POST',
            body: JSON.stringify(input),
        });

        await annotateStandbyRuns();

        const data = (await response.json()) as O;
        return {
            data,
            status: response.status,
            headers: response.headers,
        };
    };
};

interface StandbyTask {
    standbyUrl: string;
    taskId: string;
}

/**
 * Creates a task with specific `build` - either `buildNumber` or default.
 *
 * @throws if actor doesn't exist or it doesn't support standby mode.
 */
export const createStandbyTask = async (actorNameOrId: string, buildNumber?: string): Promise<StandbyTask> => {
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
    delete defaultActorStandby.disableStandbyFieldsOverride;

    const build = buildNumber ?? defaultActorStandby.build;

    const actorStandbyOptions: ActorStandby = {
        ...defaultActorStandby,
        build,
    };

    try {
        const title = `Test task - ${build}`.slice(0, 62);
        const randomValueLength = 15;
        // we try to create unique task name containing only `a-z0-9-` characters and at most 63 characters long
        const randomValue = Math.random().toString(10).slice(2).padEnd(randomValueLength, '0');
        const name = `test-${randomValue.slice(0, randomValueLength)}`;
        const newTask = (await apifyClient.tasks().create({
            actId: actorNameOrId,
            actorStandby: actorStandbyOptions,
            description: `Task for testing standby version ${build} of actor "${actorNameOrId}"`,
            title,
            name,
        })) as Task & { standbyUrl?: string };

        const { id, standbyUrl } = newTask;

        if (!standbyUrl) {
            throw new Error(`Task "${id} doesn't contain standbyUrl property`);
        }

        return {
            standbyUrl,
            taskId: id,
        };
    } catch (error) {
        throw new Error(`Failed to create task: ${error}`);
    }
};

const createStartRunFn = <T>(actorNameOrId: string, testContext: TestContext) => {
    const { annotate, task } = testContext;
    const actorConfig = config.get(actorNameOrId);
    const build = actorConfig?.buildNumber;
    const buildId = actorConfig?.buildId;
    return async (runOptions: RunOptions<T>) => {
        const { input, options, prefilledInput, runId } = runOptions;

        if (runId) {
            const run = await apifyClient.run(runId).get();
            if (!run) {
                throw new Error(`Run with id "${runId}" doesn't exist`);
            }
            return new RunTestResult(apifyClient, run);
        }

        const actor = apifyClient.actor(actorNameOrId);

        const actorInput = {
            ...(prefilledInput && (await getActorPrefilledInput(apifyClient, actorNameOrId, buildId))),
            ...input,
        };
        const run = await actor.call(actorInput, { build, log: null, ...options });

        const runLink = generateRunLink(run);
        await annotate(`${task.name} - ${runLink}`, 'run_link');
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
};
