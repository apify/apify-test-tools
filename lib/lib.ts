import type { Actor, ActorRun, ActorRunListItem } from 'apify-client';
import { ApifyClient } from 'apify-client';
import type { SuiteFactory, TestContext, TestFunction } from 'vitest';
import { describe as vitestDescribe, ExpectStatic, test as vitestTest } from 'vitest';

import {
    ACTOR_FULL_NAME_REGEX,
    DATASET_SYNC_DELAY_MS,
    DEFAULT_TEST_ACTOR_TIMEOUT_SECS,
    DEFAULT_TEST_RUN_DURATION_MS,
} from './consts.js';
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

const config = new Map(actorBuilds.map((build) => [build.actorFullName, build]));

export { ExpectStatic };

const apifyClients = new Map<string, ApifyClient>();

/**
 * The client an Actor's tests run with: the token in the env var listed with the Actor in `ACTOR_BUILDS`, which `test`
 * takes from `testTokenEnvVar` in `apify-test-tools.config.json`. It throws inside the test, so an Actor without its
 * token fails only its own tests, and the other Actors' tests still run.
 */
const getApifyClient = (actorFullName: string): ApifyClient => {
    const testTokenEnvVar = config.get(actorFullName)?.testTokenEnvVar;
    if (!testTokenEnvVar) {
        throw new Error(
            `ACTOR_BUILDS names no testTokenEnvVar for Actor "${actorFullName}", so its tests have no token to run with.`,
        );
    }
    const token = process.env[testTokenEnvVar];
    if (!token) {
        throw new Error(`${testTokenEnvVar} is not set. The tests of Actor "${actorFullName}" need it.`);
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
 *
 * @throws when `actorFullName` isn't a full name, so its test file fails to load: a test naming its Actor by another ID
 * would never match `ACTOR_BUILDS` and would be skipped without a word.
 */
const defineActorTest = (
    actorFullName: string,
    testName: string,
    testOptions: ActorTestOptions | undefined,
    body: (context: TestContext, name: string) => Promise<void>,
) => {
    if (!ACTOR_FULL_NAME_REGEX.test(actorFullName)) {
        throw new Error(
            `Test "${testName}" names its Actor "${actorFullName}", which is not a full name. Name the Actor ` +
                'as owner/name, e.g. "apify/web-scraper".',
        );
    }
    const options = { ...DEFAULT_TEST_OPTIONS, ...testOptions };
    const name = `${actorFullName}: ${testName}`;
    vitestTest.runIf(config.has(actorFullName))(name, options, async (context) => {
        await body({ ...context, expect: extendExpect(context.expect) }, name);
    });
};

/**
 * `fn` gets `run`, which starts the Actor, and `apifyClient`, the client with the token the Actor's tests run with,
 * e.g. to read storages the run left elsewhere.
 *
 * @param actorFullName - The Actor's full name, `owner/name`, e.g. `"apify/web-scraper"`.
 */
export const testActor = <T>(
    actorFullName: string,
    testName: string,
    fn: TestFunction<{ run: ReturnType<typeof createStartRunFn<T>>; apifyClient: ApifyClient }>,
    testOptions?: ActorTestOptions,
) => {
    defineActorTest(actorFullName, testName, testOptions, async (context) => {
        const apifyClient = getApifyClient(actorFullName);
        await fn({ ...context, apifyClient, run: createStartRunFn(apifyClient, actorFullName, context) });
    });
};

/**
 * Tests an Actor's server interface directly. A build listed in `ACTOR_BUILDS` is targeted with the X-Actor-Build
 * header, otherwise the platform serves the Actor's configured server interface build.
 *
 * @param actorFullName - The Actor's full name, `owner/name`, e.g. `"apify/web-scraper"`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const testServerInterfaceActor = <I = any, O = any>(
    actorFullName: string,
    testName: string,
    fn: TestFunction<{
        sendRequestToServer: ReturnType<typeof createSendRequestToServerFn<I, O>>;
        apifyClient: ApifyClient;
    }>,
    testOptions?: ActorTestOptions,
) => {
    defineActorTest(actorFullName, testName, testOptions, async (context) => {
        const apifyClient = getApifyClient(actorFullName);
        const serverInterface = await getServerInterface(
            apifyClient,
            actorFullName,
            config.get(actorFullName)?.buildNumber,
        );
        await fn({
            ...context,
            sendRequestToServer: createSendRequestToServerFn<I, O>({ ...serverInterface, apifyClient }),
            apifyClient,
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
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            run: () => {},
            ...rest,
        });
    });
};

/** Whether `body` goes out as it is, rather than as JSON */
const isRawBody = (body: unknown): body is BodyInit =>
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams;

/**
 * Sends a request directly to the Actor's server interface: to `path`, with the `query` parameters and the `body`.
 * Returns the raw response `text` too. `data` is the text parsed as JSON, or `undefined` when it isn't JSON (e.g. an
 * HTML error page), so a test can still assert the status and show what came back.
 */
const createSendRequestToServerFn = <I, O>({
    url,
    build,
    apifyClient,
}: ServerInterface & { apifyClient: ApifyClient }) => {
    return async ({ path = '', query = {}, method, body, headers = {} }: ServerRequest<I> = {}) => {
        const target = new URL(url.replace(/\/+$/, '') + (path && !path.startsWith('/') ? `/${path}` : path));
        for (const [name, values] of Object.entries(query)) {
            for (const value of [values].flat()) {
                if (value !== undefined) target.searchParams.append(name, String(value));
            }
        }

        const requestHeaders = new Headers(headers);
        let requestBody = body as BodyInit | undefined;
        if (body !== undefined && !isRawBody(body)) {
            requestBody = JSON.stringify(body);
            if (!requestHeaders.has('Content-Type')) {
                requestHeaders.set('Content-Type', 'application/json');
            }
        }
        requestHeaders.set('Authorization', `Bearer ${apifyClient.token}`);
        if (build !== undefined) {
            requestHeaders.set('X-Actor-Build', build);
        }
        const response = await fetch(target, {
            headers: requestHeaders,
            method: method ?? (body === undefined ? 'GET' : 'POST'),
            body: requestBody,
        });

        const text = await response.text();
        let data: O;
        try {
            data = JSON.parse(text) as O;
        } catch {
            data = undefined as O;
        }
        return {
            data,
            text,
            status: response.status,
            headers: response.headers,
        };
    };
};

type QueryValue = string | number | boolean | undefined;

/** A request `sendRequestToServer` sends to the Actor's server interface */
type ServerRequest<I> = {
    /** The path on the server, e.g. `/search`. A query string in it is kept */
    path?: string;
    /** Query parameters added to the URL. An array adds the parameter once per value, `undefined` leaves it out */
    query?: Record<string, QueryValue | QueryValue[]>;
    /** By default `POST` with a body and `GET` without one */
    method?: string;
    /**
     * A string, `Buffer` or other typed array, `ArrayBuffer`, `Blob`, `FormData` or `URLSearchParams` is sent as it is,
     * with the content type `fetch` gives it unless `headers` set one. Anything else is sent as JSON, as
     * `application/json` unless `headers` set another type.
     */
    body?: I | BodyInit;
    headers?: Record<string, string>;
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
    actorFullName: string,
    buildNumber?: string,
): Promise<ServerInterface> => {
    const actorInfo = (await apifyClient.actor(actorFullName).get()) as (Actor & { standbyUrl?: string }) | undefined;
    if (!actorInfo) {
        throw new Error(`Actor "${actorFullName}" not found`);
    }
    if (!actorInfo.standbyUrl) {
        throw new Error(`Actor "${actorFullName}" doesn't have a server interface`);
    }

    return {
        url: actorInfo.standbyUrl,
        build: buildNumber,
    };
};

const createStartRunFn = <T>(apifyClient: ApifyClient, actorFullName: string, testContext: TestContext) => {
    const { annotate, task } = testContext;
    const actorConfig = config.get(actorFullName);
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
            ...(prefilledInput && (await getActorPrefilledInput(apifyClient, actorFullName, buildId))),
            ...input,
        };

        const actor = apifyClient.actor(actorFullName);
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
            actorFullName,
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
export const _private = { createStartRunFn, createSendRequestToServerFn, getServerInterface } as const;
