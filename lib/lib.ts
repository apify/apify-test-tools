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

const apifyClients = new Map<string, ApifyClient>();

/**
 * The token the tests fall back to. A CLI older than per-Actor tokens names none, and a caller may not pass the
 * Actors' own tokens yet, so it stays until every repository and caller has moved over.
 */
const FALLBACK_TOKEN_ENV_VAR = 'TESTER_APIFY_TOKEN';
const warnedFallbacks = new Set<string>();

/**
 * The client an Actor's tests run with: the token in the env var listed with the Actor in `ACTOR_BUILDS`, which `test`
 * takes from `testTokenEnvVar` in `apify-test-tools.config.json` (the Actor's `tokenEnvVar` by default). Without one,
 * or when it isn't set, `TESTER_APIFY_TOKEN`. It throws inside the test, so an Actor without any token fails only its
 * own tests, and the other Actors' tests still run.
 */
const getApifyClient = (actorId: string): ApifyClient => {
    const testTokenEnvVar = config.get(actorId)?.testTokenEnvVar;
    let tokenEnvVar = testTokenEnvVar;
    if (!tokenEnvVar || !process.env[tokenEnvVar]) {
        tokenEnvVar = FALLBACK_TOKEN_ENV_VAR;
        if (testTokenEnvVar && !warnedFallbacks.has(testTokenEnvVar) && process.env[FALLBACK_TOKEN_ENV_VAR]) {
            warnedFallbacks.add(testTokenEnvVar);
            console.warn(`${testTokenEnvVar} is not set, testing with ${FALLBACK_TOKEN_ENV_VAR} instead.`);
        }
    }
    const token = process.env[tokenEnvVar];
    if (!token) {
        const own = testTokenEnvVar ? `${testTokenEnvVar} nor ` : '';
        throw new Error(
            `Neither ${own}${FALLBACK_TOKEN_ENV_VAR} is set. The tests of Actor "${actorId}" need a token.`,
        );
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
 * `npm test` stays unaffected. `TESTER_APIFY_TOKEN` alone still enables them, as it did before per-Actor tokens.
 */
export const describe = (name: string, fn?: SuiteFactory<object>, options: ActorTestOptions = DEFAULT_TEST_OPTIONS) => {
    vitestDescribe.runIf(actorBuilds.length > 0 || !!process.env[FALLBACK_TOKEN_ENV_VAR])(name, options, fn);
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
 * Tests an Actor's server interface directly. A build listed in `ACTOR_BUILDS` is targeted with the X-Actor-Build
 * header, otherwise the platform serves the Actor's configured server interface build.
 *
 * @param actorId - The actor's raw platform ID or its full name (`owner/name`, e.g. `"apify/web-scraper"`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const testServerInterfaceActor = <I = any, O = any>(
    actorId: string,
    testName: string,
    fn: TestFunction<{
        callServerInterface: ReturnType<typeof createCallServerInterfaceFn<I, O>>;
        apifyClient: ApifyClient;
    }>,
    testOptions?: ActorTestOptions,
) => {
    defineActorTest(actorId, testName, testOptions, async (context) => {
        const apifyClient = getApifyClient(actorId);
        const serverInterface = await getServerInterface(apifyClient, actorId, config.get(actorId)?.buildNumber);
        await fn({
            ...context,
            callServerInterface: createCallServerInterfaceFn<I, O>({ ...serverInterface, apifyClient }),
            apifyClient,
        });
    });
};

/**
 * @deprecated Use `testServerInterfaceActor`, whose `fn` gets `callServerInterface` instead of `callStandby`. The
 * platform renamed standby mode to server interface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const testStandbyActor = <I = any, O = any>(
    actorId: string,
    testName: string,
    fn: TestFunction<{
        callStandby: ReturnType<typeof createCallServerInterfaceFn<I, O>>;
        apifyClient: ApifyClient;
    }>,
    testOptions?: ActorTestOptions,
) => {
    testServerInterfaceActor<I, O>(
        actorId,
        testName,
        (context) => fn({ ...context, callStandby: context.callServerInterface }),
        testOptions,
    );
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
 * Sends JSON input directly to the Actor's server interface URL, as `application/json` unless `headers` set another type.
 * Returns the raw response `body` too. `data` is the body parsed as JSON, or `undefined` when it isn't JSON (e.g. an
 * HTML error page), so a test can still assert the status and show what came back.
 */
const createCallServerInterfaceFn = <I, O>({
    url,
    build,
    apifyClient,
}: ServerInterface & { apifyClient: ApifyClient }) => {
    return async ({
        input,
        path = '',
        headers = {},
    }: Pick<RunOptions<I>, 'input'> & { path?: string; headers?: Record<string, string> }) => {
        const requestHeaders = new Headers(headers);
        if (!requestHeaders.has('Content-Type')) {
            requestHeaders.set('Content-Type', 'application/json');
        }
        requestHeaders.set('Authorization', `Bearer ${apifyClient.token}`);
        if (build !== undefined) {
            requestHeaders.set('X-Actor-Build', build);
        }
        const response = await fetch(url + path, {
            headers: requestHeaders,
            method: 'POST',
            body: JSON.stringify(input),
        });

        const body = await response.text();
        let data: O;
        try {
            data = JSON.parse(body) as O;
        } catch {
            data = undefined as O;
        }
        return {
            data,
            body,
            status: response.status,
            headers: response.headers,
        };
    };
};

interface ServerInterface {
    url: string;
    build?: string;
}

/**
 * Resolves the Actor's server interface URL, and the build from `ACTOR_BUILDS` to target with `X-Actor-Build`. Without
 * one, the tests run on the Actor's default build, so no header is sent and the platform serves its configured server
 * interface build. The platform API still calls the server interface standby (`standbyUrl`, `actorStandby`).
 * That keeps default-build runs working for testers without write access to the Actor.
 */
const getServerInterface = async (
    apifyClient: ApifyClient,
    actorId: string,
    buildNumber?: string,
): Promise<ServerInterface> => {
    const actorInfo = (await apifyClient.actor(actorId).get()) as (Actor & { standbyUrl?: string }) | undefined;
    if (!actorInfo) {
        throw new Error(`Actor "${actorId}" not found`);
    }
    if (!actorInfo.standbyUrl) {
        throw new Error(`Actor "${actorId}" doesn't have a server interface`);
    }

    return {
        url: actorInfo.standbyUrl,
        build: buildNumber,
    };
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
export const _private = { createStartRunFn, createCallServerInterfaceFn, getServerInterface } as const;
