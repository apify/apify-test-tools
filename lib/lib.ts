import type { Actor, ActorRun, ActorRunListItem } from 'apify-client';
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

const { TESTER_APIFY_TOKEN } = process.env;
const apifyClient = new ApifyClient({ token: TESTER_APIFY_TOKEN });

const DEFAULT_TEST_OPTIONS: ActorTestOptions = {
    // we want to run tests concurrently
    concurrent: true,
    // test should finish within 1 hour
    timeout: DEFAULT_TEST_RUN_DURATION_MS,
    retry: 1,
};

/**
 * Platform tests need `TESTER_APIFY_TOKEN` to talk to the platform, so without it we skip them altogether.
 */
export const describe = (name: string, fn?: SuiteFactory<object>, options: ActorTestOptions = DEFAULT_TEST_OPTIONS) => {
    vitestDescribe.runIf(!!TESTER_APIFY_TOKEN)(name, options, fn);
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
 * @param actorId - The actor's raw platform ID or its full name (`owner/name`, e.g. `"apify/web-scraper"`).
 */
export const testActor = <T>(
    actorId: string,
    testName: string,
    fn: TestFunction<{ run: ReturnType<typeof createStartRunFn<T>> }>,
    testOptions?: ActorTestOptions,
) => {
    defineActorTest(actorId, testName, testOptions, async (context) => {
        await fn({ ...context, run: createStartRunFn(actorId, context) });
    });
};

/**
 * Tests a standby Actor directly, targeting the configured build with the X-Actor-Build header.
 *
 * @param actorId - The actor's raw platform ID or its full name (`owner/name`, e.g. `"apify/web-scraper"`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const testStandbyActor = <I = any, O = any>(
    actorId: string,
    testName: string,
    fn: TestFunction<{ callStandby: ReturnType<typeof createStartStandbyFn<I, O>> }>,
    testOptions?: ActorTestOptions,
) => {
    defineActorTest(actorId, testName, testOptions, async (context) => {
        const standbyActor = await getStandbyActor(actorId, config.get(actorId)?.buildNumber);
        await fn({ ...context, callStandby: createStartStandbyFn<I, O>(standbyActor) });
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

/** Sends JSON input directly to the Actor's standby URL. */
const createStartStandbyFn = <I, O>({ standbyUrl, build }: StandbyActor) => {
    return async ({
        input,
        path = '',
        headers = {},
    }: Pick<RunOptions<I>, 'input'> & { path?: string; headers?: Record<string, string> }) => {
        const requestHeaders = new Headers(headers);
        requestHeaders.set('Authorization', `Bearer ${apifyClient.token}`);
        if (build !== undefined) {
            requestHeaders.set('X-Actor-Build', build);
        }
        const response = await fetch(standbyUrl + path, {
            headers: requestHeaders,
            method: 'POST',
            body: JSON.stringify(input),
        });

        const data = (await response.json()) as O;
        return {
            data,
            status: response.status,
            headers: response.headers,
        };
    };
};

interface StandbyActor {
    standbyUrl: string;
    build?: string;
}

/** Resolves the Actor's standby URL and the selected build number or tag. */
const getStandbyActor = async (actorId: string, buildNumber?: string): Promise<StandbyActor> => {
    const actorInfo = (await apifyClient.actor(actorId).get()) as (Actor & { standbyUrl?: string }) | undefined;
    if (!actorInfo) {
        throw new Error(`Actor "${actorId}" not found`);
    }
    if (!actorInfo.standbyUrl) {
        throw new Error(`Actor "${actorId}" doesn't support standby mode`);
    }

    return {
        standbyUrl: actorInfo.standbyUrl,
        build: buildNumber ?? actorInfo.actorStandby?.build,
    };
};

const createStartRunFn = <T>(actorId: string, testContext: TestContext) => {
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
export const _private = { createStartRunFn, createStartStandbyFn, getStandbyActor } as const;
