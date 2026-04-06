import { fileURLToPath } from 'node:url';

import { ApifyClient } from 'apify-client';
import type { SuiteFactory, TestContext, TestFunction } from 'vitest';
import { describe as vitestDescribe, ExpectStatic, test as vitestTest } from 'vitest';

import { DEFAULT_DESCRIBE_OPTIONS, DEFAULT_TEST_ACTOR_OPTIONS, DEFAULT_TRIGGERS } from './consts.js';
import { extendExpect } from './extend-expect.js';
import { shouldRunForTrigger } from './trigger.js';
import type { ActorBuild, ActorTestOptions, DescribeConfig, TestActorConfig, TriggerConfig } from './types.js';
import { createStandbyTask, createStartRunFn, createStartStandbyFn, generateRunLink } from './utils.js';

export { getCurrentTrigger, TRIGGER_ENV_VAR } from './trigger.js';
export { ExpectStatic };

// ---------------------------------------------------------------------------
// Actor builds — loaded once at startup from the ACTOR_BUILDS env var
// ---------------------------------------------------------------------------

let actorBuilds: ActorBuild[] = [];
try {
    const raw = process.env.ACTOR_BUILDS;
    if (raw) {
        actorBuilds = JSON.parse(raw);
        if (!Array.isArray(actorBuilds)) {
            throw new Error(`ACTOR_BUILDS env variable should contain a JSON array, got ${typeof actorBuilds}`);
        }
    }
} catch (err) {
    throw new Error(`Failed to parse actor builds: ${err}`);
}

const actorConfig = actorBuilds.reduce<Map<string, ActorBuild>>((map, cfg) => {
    map.set(cfg.actorName, cfg);
    map.set(cfg.actorId, cfg);
    return map;
}, new Map());

const { TESTER_APIFY_TOKEN, RUN_PLATFORM_TESTS, RUN_ALL_PLATFORM_TESTS } = process.env;
const apifyClient = new ApifyClient({ token: TESTER_APIFY_TOKEN });

// ---------------------------------------------------------------------------
// Hierarchical trigger stack
// Describes push their triggers onto the stack before collecting their
// children; testActor reads the merged result at registration time.
// Since vitest calls the suite factory synchronously, the stack is always
// consistent during collection.
// ---------------------------------------------------------------------------

// Strip the extension so the comparison works for both .ts (source maps) and .js (compiled).
const THIS_FILE_BASE = fileURLToPath(import.meta.url).replace(/\.[jt]s$/, '');

/**
 * Returns the file path of the first call-stack frame outside this library file.
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
 * Returns DEFAULT_TRIGGERS, with hourly promoted to true when the caller file is
 * under BACKWARD_COMPATIBLE_HOURLY_DIR. This allows a specific directory (e.g. core/)
 * to retain pre-config-system hourly behaviour without touching individual test files.
 */
function getEffectiveDefaults(callerFile: string | undefined): TriggerConfig {
    const hourlyDir = process.env.BACKWARD_COMPATIBLE_HOURLY_DIR;
    if (hourlyDir && callerFile && (callerFile.includes(`/${hourlyDir}/`) || callerFile.includes(`\\${hourlyDir}\\`))) {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

    triggersStack.push(triggers ?? {});
    const merged = mergeInheritedTriggers([getEffectiveDefaults(callerFile), ...triggersStack]);
    const shouldRun = (!!RUN_PLATFORM_TESTS || !!RUN_ALL_PLATFORM_TESTS) && shouldRunForTrigger(merged.runWhen);

    vitestDescribe.runIf(shouldRun)(name, options ?? {}, (test) => {
        fn?.(test);
    });

    triggersStack.pop();
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
    const callerFile = getCallerFile();

    const effectiveTriggers = mergeInheritedTriggers([
        getEffectiveDefaults(callerFile),
        ...triggersStack,
        ...(triggers !== undefined ? [triggers] : []),
    ]);
    const shouldRun =
        (!!RUN_ALL_PLATFORM_TESTS || actorConfig.has(actorName)) && shouldRunForTrigger(effectiveTriggers.runWhen);

    return { fullName: `${actorName}: ${name}`, effectiveTriggers, vitestOptions: options ?? {}, shouldRun };
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
            run: createStartRunFn(apifyClient, actorConfig, actorName, context),
            ...rest,
        });
    });
};

/**
 * Creates a new task with a specific build of the standby actor and provides
 * a `callStandby` function that calls the task's standby URL.
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

        const standbyTask = await createStandbyTask(apifyClient, actorName, actorConfig.get(actorName)?.buildNumber);
        const { annotate } = context;
        const { expect, ...rest } = context;

        // NOTE: wrap `fn` in try-catch so the task is always cleaned up afterwards
        try {
            await fn({
                expect: extendExpect(expect),
                callStandby: createStartStandbyFn(apifyClient, standbyTask),
                ...rest,
            });
        } catch {
            /* */
        }

        const { taskId } = standbyTask;
        const runs = (await apifyClient.task(taskId).runs().list()).items;
        for (const run of runs) {
            await annotate(`${fullName} - ${generateRunLink(run)}`, 'run_link');
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
