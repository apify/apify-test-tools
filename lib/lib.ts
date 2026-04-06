import { fileURLToPath } from 'node:url';

import type { Actor, ActorRun, ActorRunListItem, ActorStandby, Task } from 'apify-client';
import { ApifyClient } from 'apify-client';
import type { SuiteFactory, TestContext, TestFunction } from 'vitest';
import { describe as vitestDescribe, ExpectStatic, test as vitestTest } from 'vitest';

import { extendExpect } from './extend-expect.js';
import { RunTestResult } from './run-test-result.js';
import { shouldRunForTrigger } from './trigger.js';
import type {
    ActorBuild,
    ActorTestOptions,
    DescribeConfig,
    RunOptions,
    RunWhenConfig,
    TestActorConfig,
    TriggerConfig,
} from './types.js';
import { getActorPrefilledInput, sleep } from './utils.js';

export { getCurrentTrigger, TRIGGER_ENV_VAR } from './trigger.js';

// ---------------------------------------------------------------------------
// Hierarchical config stack
// Describes push their triggers onto the stack before collecting their
// children; testActor reads the merged result at registration time.
// Since vitest calls the suite factory synchronously, the stack is always
// consistent during collection.
// ---------------------------------------------------------------------------

// Default trigger config.
// `Required<RunWhenConfig>` ensures a compile error when a new TriggerType is added,
// forcing an explicit opt-in/opt-out decision for existing tests.
// hourly is false by default — only specific directories (e.g. core/) run hourly,
// controlled via BACKWARD_COMPATIBLE_HOURLY_DIR.
const DEFAULT_TRIGGERS: { runWhen: Required<RunWhenConfig> } = {
    runWhen: { hourly: false, daily: true, pullRequest: true },
};

// Strip the extension so the comparison works for both .ts (source maps) and .js (compiled).
const THIS_FILE_BASE = fileURLToPath(import.meta.url).replace(/\.[jt]s$/, '');

export const { BACKWARD_COMPATIBLE_HOURLY_DIR } = process.env;

/**
 * Returns the file path of the first call-stack frame that is outside this library file.
 * Used at describe/testActor registration time to detect which test file is calling.
 */
function getCallerFile(): string | undefined {
    for (const line of (new Error().stack ?? '').split('\n').slice(1)) {
        const match = line.match(/\((.+?):\d+:\d+\)/) ?? line.match(/^\s+at (.+?):\d+:\d+\s*$/);
        if (!match) continue;
        const filePath = match[1].replace(/^file:\/\//, '');
        if (filePath.replace(/\.[jt]s$/, '') === THIS_FILE_BASE) continue;
        if (filePath.startsWith('node:') || filePath.includes('node_modules')) continue;
        return filePath;
    }
    return undefined;
}

/**
 * Returns DEFAULT_TRIGGERS, with hourly promoted to true when the caller file
 * is under BACKWARD_COMPATIBLE_HOURLY_DIR. This allows a specific directory
 * (e.g. core/) to retain its pre-config-system hourly behaviour without any
 * changes to individual test files.
 */
function getEffectiveDefaults(callerFile: string | undefined): TriggerConfig {
    if (
        BACKWARD_COMPATIBLE_HOURLY_DIR &&
        callerFile &&
        (callerFile.includes(`/${BACKWARD_COMPATIBLE_HOURLY_DIR}/`) ||
            callerFile.includes(`\\${BACKWARD_COMPATIBLE_HOURLY_DIR}\\`))
    ) {
        return { runWhen: { ...DEFAULT_TRIGGERS.runWhen, hourly: true } };
    }
    return DEFAULT_TRIGGERS;
}

const triggersStack: TriggerConfig[] = [];

/**
 * Merges a sequence of trigger layers left-to-right (outermost → innermost).
 * Both `runWhen` and `alerts` are shallow-merged field-by-field so children only
 * need to override the specific keys they want to change.
 *
 * Exported for unit testing.
 */
export function mergeInheritedTriggers(layers: TriggerConfig[]): TriggerConfig {
    return layers.reduce<TriggerConfig>(
        (merged, layer) => ({
            runWhen: layer.runWhen !== undefined ? { ...merged.runWhen, ...layer.runWhen } : merged.runWhen,
            alerts: layer.alerts !== undefined ? { ...merged.alerts, ...layer.alerts } : merged.alerts,
        }),
        {},
    );
}

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

const DEFAULT_DESCRIBE_OPTIONS = {
    concurrent: true,
    timeout: 60_000 * 60,
};

/**
 * Wraps a suite of actor tests. Conditionally runs based on environment flags
 * and the `runWhen` trigger config.
 *
 * Preferred (new) style — config object with `name`:
 * ```ts
 * // All triggers enabled by default — opt out of specific ones:
 * describe({ name: 'my-actor', triggers: { runWhen: { pullRequest: false }, alerts: { slack: true } } }, () => { ... });
 * ```
 *
 * Legacy style — still supported:
 * ```ts
 * describe('my-actor', () => { ... });
 * describe('my-actor', () => { ... }, { timeout: 120_000 });
 * ```
 */
export const describe = (
    configOrName: DescribeConfig | string,
    fn?: SuiteFactory<object>,
    legacyOptions?: ActorTestOptions,
) => {
    const resolved: DescribeConfig =
        typeof configOrName === 'string'
            ? { name: configOrName, options: { ...DEFAULT_DESCRIBE_OPTIONS, ...legacyOptions } }
            : { options: DEFAULT_DESCRIBE_OPTIONS, ...configOrName };

    const { name, triggers, options } = resolved;
    const callerFile = getCallerFile();

    // Push this describe's triggers onto the stack before collecting children
    triggersStack.push(triggers ?? {});

    const merged = mergeInheritedTriggers([getEffectiveDefaults(callerFile), ...triggersStack]);
    const shouldRun = (!!RUN_PLATFORM_TESTS || !!RUN_ALL_PLATFORM_TESTS) && shouldRunForTrigger(merged.runWhen);

    vitestDescribe.runIf(shouldRun)(name, options ?? {}, (test) => {
        fn?.(test);
    });

    // Pop after vitest has synchronously collected all children
    triggersStack.pop();
};

const DEFAULT_TEST_ACTOR_OPTIONS = {
    retry: 1,
};

/**
 * Resolves and merges config for testActor / testStandbyActor.
 * Handles both the new config-object style and the legacy string style.
 */
function resolveActorTestConfig(
    actorName: string,
    configOrName: TestActorConfig | string,
    legacyOptions?: ActorTestOptions,
) {
    const resolved: TestActorConfig =
        typeof configOrName === 'string'
            ? { name: configOrName, options: { ...DEFAULT_TEST_ACTOR_OPTIONS, ...legacyOptions } }
            : { ...configOrName, options: { ...DEFAULT_TEST_ACTOR_OPTIONS, ...configOrName.options } };

    const { name, triggers, options } = resolved;
    const fullName = `${actorName}: ${name}`;
    const callerFile = getCallerFile();

    // Merge with inherited triggers from enclosing describe(s)
    const effectiveTriggers = mergeInheritedTriggers([
        getEffectiveDefaults(callerFile),
        ...triggersStack,
        ...(triggers !== undefined ? [triggers] : []),
    ]);
    const shouldRun =
        (!!RUN_ALL_PLATFORM_TESTS || config.has(actorName)) && shouldRunForTrigger(effectiveTriggers.runWhen);

    return { fullName, effectiveTriggers, vitestOptions: options ?? {}, shouldRun };
}

/**
 * Registers a platform actor test. Conditionally runs based on whether the
 * actor was built and the `runWhen` trigger config (inherited from enclosing
 * `describe` blocks and optionally overridden per test).
 *
 * Preferred (new) style — config object with `name`:
 * ```ts
 * // Inherits triggers from enclosing describe; override only what differs:
 * testActor(actorId, { name: 'smoke', triggers: { runWhen: { pullRequest: false } } }, async ({ run, expect }) => { ... });
 * ```
 *
 * Legacy style — still supported:
 * ```ts
 * testActor(actorId, 'smoke', async ({ run, expect }) => { ... });
 * testActor(actorId, 'smoke', async ({ run, expect }) => { ... }, { retry: 2 });
 * ```
 */
export const testActor = <T>(
    actorName: string,
    configOrName: TestActorConfig | string,
    fn: TestFunction<{ run: ReturnType<typeof createStartRunFn<T>> }>,
    legacyOptions?: ActorTestOptions,
) => {
    const { fullName, effectiveTriggers, vitestOptions, shouldRun } = resolveActorTestConfig(
        actorName,
        configOrName,
        legacyOptions,
    );

    vitestTest.runIf(shouldRun)(fullName, vitestOptions, async <TYPE extends TestContext>(context: TYPE) => {
        // Embed alerts config in task.meta so the JSON reporter serializes it
        // and report-tests can read it alongside runLink / actorName.
        // @ts-expect-error: `TaskMeta` cannot be retyped
        context.task.meta = { ...context.task.meta, alerts: effectiveTriggers.alerts };

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
 *
 * Preferred (new) style — config object with `name`:
 * ```ts
 * testStandbyActor(actorId, { name: 'CDS standby', triggers: { runWhen: { pullRequest: false } } }, async ({ callStandby }) => { ... });
 * ```
 *
 * Legacy style — still supported:
 * ```ts
 * testStandbyActor(actorId, 'CDS standby', async ({ callStandby }) => { ... });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const testStandbyActor = <I = any, O = any>(
    actorName: string,
    configOrName: TestActorConfig | string,
    fn: TestFunction<{ callStandby: ReturnType<typeof createStartStandbyFn<I, O>> }>,
    legacyOptions?: ActorTestOptions,
) => {
    const { fullName, effectiveTriggers, vitestOptions, shouldRun } = resolveActorTestConfig(
        actorName,
        configOrName,
        legacyOptions,
    );

    vitestTest.runIf(shouldRun)(fullName, vitestOptions, async <T extends TestContext>(context: T) => {
        // @ts-expect-error: `TaskMeta` cannot be retyped
        context.task.meta = { ...context.task.meta, alerts: effectiveTriggers.alerts };

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
        } catch {
            /* */
        }

        const { taskId } = standbyTask;
        const runs = (await apifyClient.task(taskId).runs().list()).items;
        for (const run of runs) {
            const runLink = generateRunLink(run);
            await annotate(`${fullName} - ${runLink}`, 'run_link');
        }

        if (taskId) {
            await apifyClient.task(taskId).delete();
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

const randomInt = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

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
    delete defaultActorStandby.disableStandbyFieldsOverride;

    const build = buildNumber ?? defaultActorStandby.build;

    const actorStandbyOptions: ActorStandby = {
        ...defaultActorStandby,
        build,
    };

    try {
        const title = `Test task - ${build}:${actorNameOrId}`.slice(0, 62);
        // we try to create unique task name containing only `a-z0-9-` characters and at most 63 characters long
        const name = `${randomInt(1, 1_000_000)}${title
            .toLowerCase()
            .replaceAll(/\s+/g, '')
            .replaceAll(/[^a-z0-9-]+/g, '-')}`.slice(0, 62);
        const newTask = (await apifyClient.tasks().create({
            actId: actorNameOrId,
            actorStandby: actorStandbyOptions,
            description: `Task for testing standby version ${build}`,
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
