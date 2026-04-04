import type { RunWhenConfig, TriggerType } from './types.js';

export const TRIGGER_ENV_VAR = 'TEST_TRIGGER';

const VALID_TRIGGERS: readonly TriggerType[] = ['hourly', 'daily', 'pullRequest', 'locally'];

/**
 * Returns the current trigger type based on the `TEST_TRIGGER` environment variable.
 * Falls back to `'locally'` when the variable is absent or unrecognized.
 *
 * In GitHub Actions workflows, set the env var before running tests:
 * ```yaml
 * env:
 *   TEST_TRIGGER: pullRequest   # or: hourly | daily | locally
 * ```
 */
export function getCurrentTrigger(): TriggerType {
    const raw = process.env[TRIGGER_ENV_VAR];
    if (raw && (VALID_TRIGGERS as readonly string[]).includes(raw)) {
        return raw as TriggerType;
    }
    return 'locally';
}

/**
 * Returns `true` when the test should run for the current trigger.
 *
 * - If `runWhen` is omitted the test always runs (backwards-compatible default).
 * - Otherwise only runs when `runWhen[currentTrigger] === true`.
 */
export function shouldRunForTrigger(runWhen: RunWhenConfig | undefined): boolean {
    if (!runWhen) return true;
    return getCurrentTrigger() in runWhen && runWhen[getCurrentTrigger()] === true;
}
