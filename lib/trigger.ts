import type { RunWhenConfig, TriggerType } from './types.js';

export const TRIGGER_ENV_VAR = 'TEST_TRIGGER';

const VALID_TRIGGERS: readonly TriggerType[] = ['hourly', 'daily', 'pullRequest'];

/**
 * Returns the current trigger type from the `TEST_TRIGGER` environment variable,
 * or `undefined` when the variable is absent or unrecognized.
 * When `undefined`, tests run unconditionally (no trigger-based filtering).
 *
 * In GitHub Actions workflows, set the env var before running tests:
 * ```yaml
 * env:
 *   TEST_TRIGGER: pullRequest   # or: hourly | daily
 * ```
 */
export function getCurrentTrigger(): TriggerType | undefined {
    const raw = process.env[TRIGGER_ENV_VAR];
    if (raw && (VALID_TRIGGERS as readonly string[]).includes(raw)) {
        return raw as TriggerType;
    }
    return undefined;
}

/**
 * Returns `true` when the test should run for the current trigger.
 *
 * - If `runWhen` is omitted the test always runs (backwards-compatible default).
 * - If `TEST_TRIGGER` is not set, the test always runs (no filtering).
 * - Otherwise runs only when `runWhen[currentTrigger] === true`.
 *
 * Note: callers are expected to pass the fully-merged `runWhen` (including
 * inherited defaults), so all trigger keys should already be explicitly set.
 */
export function shouldRunForTrigger(runWhen: RunWhenConfig | undefined): boolean {
    if (!runWhen) return true;
    const trigger = getCurrentTrigger();
    if (!trigger) return true;
    return runWhen[trigger] === true;
}
