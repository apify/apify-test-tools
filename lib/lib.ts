import type { Actor, ActorRun, ActorRunListItem, ActorStandby, Task } from 'apify-client';
import { ApifyClient } from 'apify-client';
import type { SuiteFactory, TestContext, TestFunction } from 'vitest';
import { describe as vitestDescribe, ExpectStatic, test as vitestTest } from 'vitest';

import { DATASET_SYNC_DELAY_MS, DEFAULT_TEST_ACTOR_TIMEOUT_SECS, DEFAULT_TEST_RUN_DURATION_MS } from './consts.js';
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
    map.set(cfg.actorFullName, cfg);
    map.set(cfg.actorRawId, cfg);
    return map;
}, new Map<string, ActorBuild>());

export { ExpectStatic };

const apifyClients = new Map<string, ApifyClient>();

/**
 * The client an Actor's tests run with: the token in the env var listed with the Actor in `ACTOR_BUILDS`, which `test`
 * takes from `testTokenEnvVar` in `apify-test-tools.config.json` (the Actor's `tokenEnvVar` by default). It throws
 * inside the test, so an Actor without a token fails only its own tests, and the other Actors' tests still run.
 */
const getApifyClient = (actorId: string): ApifyClient => {
    const tokenEnvVar = config.get(actorId)?.testTokenEnvVar;
    if (!tokenEnvVar) {
        throw new Error(
            `No test token for Actor "${actorId}" in ${ACTOR_BUILDS}. Add the Actor to apify-test-tools.config.json ` +
                `and run the tests with \`apify-test-tools test\`, which names each Actor's token.`,
        );
    }
    const token = process.env[tokenEnvVar];
    if (!token) {
        throw new Error(`${tokenEnvVar} is not set. The tests of Actor "${actorId}" run with the token in it.`);
    }
    if (!apifyClients.has(token)) apifyClients.set(token, new ApifyClient({ token }));
    return apifyClients.get(token)!;
};

const DEFAULT_TEST_OPTIONS: ActorTestOptions = {
    // we want to run tests concurrently
    concurrent: true,
    // test should finish within 1 hour
    timeout: DEFAULT_TEST_RUN_DURATION_MS,
    retry: 1,
};

/**
 * Platform tests only run on the Actors listed in `ACTOR_BUILDS`, so without any we skip them altogether. A plain
 * `npm test` stays unaffected.
 */
export const describe = (name: string, fn?: SuiteFactory<object>, options: ActorTestOptions = DEFAULT_TEST_OPTIONS) => {
    vitestDescribe.runIf(actorBuilds.length > 0)(name, options, fn);
};

/**
 * Registers a vitest test for an Actor, which only runs when the Actor is listed in `ACTOR_BUILDS`: against the build
 * listed with it, or its default build without one.
 * `body` gets the test context with the soft `expect` and the full test name.
 */
const defineActorTest = (
    actorId: string,
    testName: string,
    testOptions: ActorTestOptions | undefined,
    body: (context: TestContext, name: string) => Promise<void>,
) => {
    const options = { ...DEFAULT_TEST_OPTIONS, ...testOptions };
    const name = `${actorId}: ${testName}`;
    vitestTest.runIf(config.has(actorId))(name, options, async (context) => {
        await body({ ...context, expect: extendExpect(context.expect) }, name);
    });
};

/**
 * `fn` gets `run`, which starts the Actor, and `apifyClient`, the client with the token the Actor's tests run with,
 * e.g. to read storages the run left elsewhere.
 *
 * @param actorId - The actor's raw platform ID or its full name (`owner/name`, e.g. `"apify/web-scraper"`).
 */
export const testActor = <T>(
    actorId: string,
    testName: string,
    fn: TestFunction<{ run: ReturnType<typeof createStartRunFn<T>>; apifyClient: ApifyClient }>,
    testOptions?: ActorTestOptions,
) => {
    defineActorTest(actorId, testName, testOptions, async (context) => {
        const apifyClient = getApifyClient(actorId);
        await fn({ ...context, apifyClient, run: createStartRunFn(apifyClient, actorId, context) });
    });
};

/**
 * This wrapper creates a new task with specific `build` of the standby actor and provides
 * `callStandby` function, which calls the task's `standbyUrl`.
 *
 * Using task is just current shortcoming of standby feature but ideally we would use Actor directly
 *
 * @param actorId - The actor's raw platform ID or its full name (`owner/name`, e.g. `"apify/web-scraper"`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const testStandbyActor = <I = any, O = any>(
    actorId: string,
    testName: string,
    fn: TestFunction<{ callStandby: ReturnType<typeof createStartStandbyFn<I, O>>; apifyClient: ApifyClient }>,
    testOptions?: ActorTestOptions,
) => {
    defineActorTest(actorId, testName, testOptions, async (context, name) => {
        const apifyClient = getApifyClient(actorId);
        const standbyTask = await createStandbyTask(apifyClient, actorId, config.get(actorId)?.buildNumber);

        // NOTE: we wrap `fn` in try/finally so cleanup (deleting the task) always runs afterwards
        try {
            await fn({
                ...context,
                apifyClient,
                callStandby: createStartStandbyFn(apifyClient, standbyTask, context, name),
            });
        } finally {
            const { taskId } = standbyTask;
            // we want to delete the task at the end of the test
            await apifyClient
                .task(taskId)
                .delete()
                .catch((error) => {
                    console.error(`Failed to delete standby task "${taskId}": ${error}`);
                });
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
            run: () => {},
            ...rest,
        });
    });
};

export const it = testActor;

/**
 * Creates a function that accepts input for a standby actor and sends a request containing the input
 * to the task's standby url.
 */
const createStartStandbyFn = <I, O>(
    apifyClient: ApifyClient,
    standbyTask: StandbyTask,
    { annotate }: TestContext,
    testName: string,
) => {
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
const createStandbyTask = async (
    apifyClient: ApifyClient,
    actorId: string,
    buildNumber?: string,
): Promise<StandbyTask> => {
    const actor = apifyClient.actor(actorId);

    const actorInfo = (await actor.get()) as Actor & { standbyUrl?: string };
    if (!actorInfo) {
        throw new Error(`Actor "${actorId}" not found`);
    }

    if (!actorInfo.standbyUrl) {
        throw new Error(`Actor "${actorId}" doesn't support standby mode`);
    }

    if (!actorInfo.actorStandby) {
        throw new Error(`Actor "${actorId} doesn't contain actorStandby options`);
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
            actId: actorId,
            actorStandby: actorStandbyOptions,
            description: `Task for testing standby version ${build} of actor "${actorId}"`,
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

const createStartRunFn = <T>(apifyClient: ApifyClient, actorId: string, testContext: TestContext) => {
    const { annotate, task } = testContext;
    const actorConfig = config.get(actorId);
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

        const actorInput = {
            ...(prefilledInput && (await getActorPrefilledInput(apifyClient, actorId, buildId))),
            ...input,
        };

        const actor = apifyClient.actor(actorId);
        const actorInfo = await actor.get();
        const timeout = Math.min(
            actorInfo?.defaultRunOptions?.timeoutSecs ?? DEFAULT_TEST_ACTOR_TIMEOUT_SECS,
            DEFAULT_TEST_ACTOR_TIMEOUT_SECS,
        );

        const actorOptions = { timeout, build, log: null, ...options };
        const run = await actor.call(actorInput, actorOptions);

        const runLink = generateRunLink(run);
        await annotate(`${task.name} - ${runLink}`, 'run_link');
        // @ts-expect-error: `TaskMeta` cannot be retyped
        task.meta = {
            runId: run.id,
            runLink,
            actorId: actorConfig?.actorFullName ?? actorId,
        };

        // waiting for dataset and statistics to sync, the Apify platform is only eventually consistent.
        await sleep(DATASET_SYNC_DELAY_MS);

        return new RunTestResult(apifyClient, run);
    };
};

const generateRunLink = (run: ActorRun | ActorRunListItem): string => {
    return `https://console.apify.com/view/runs/${run.id}`;
};

/** Used for unit testing */
// eslint-disable-next-line no-underscore-dangle
export const _private = { createStartRunFn } as const;
