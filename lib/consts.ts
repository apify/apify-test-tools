import type { AlertsConfig, RunWhenConfig, ToFinishWithOptionsWithDefaults } from './types.js';

/**
 * Both the test runs and the vitest test specs should finish in this time - 1 hour
 */
export const DEFAULT_TEST_RUN_DURATION_MS = 60 * 60 * 1000; // 1 hour

// Default trigger config.
// `Required<...>` on both runWhen and alerts ensures a compile error when a new field is
// added, forcing an explicit opt-in/opt-out decision for existing tests.
// hourly is false by default — only specific directories (e.g. core/) run hourly,
// controlled via BACKWARD_COMPATIBLE_HOURLY_DIR.
export const DEFAULT_TRIGGERS: { runWhen: Required<RunWhenConfig>; alerts: Required<AlertsConfig> } = {
    runWhen: { hourly: false, daily: true, pullRequest: true },
    alerts: { slack: true },
};

export const DEFAULT_DESCRIBE_OPTIONS = {
    concurrent: true,
    timeout: DEFAULT_TEST_RUN_DURATION_MS,
};

export const DEFAULT_TEST_ACTOR_OPTIONS = {
    retry: 1,
    // prevent orphaned runs
    timeout: DEFAULT_TEST_RUN_DURATION_MS,
};

export const TO_FINISH_WITH_OPTIONS: ToFinishWithOptionsWithDefaults = {
    status: 'SUCCEEDED',
    duration: {
        min: 600, // 0.6 sec
        max: 600_000, // 10 min
    },
    failedRequests: 0,
    requestsRetries: { max: 3 },
    maxRetriesPerRequest: null,
    forbiddenLogs: ['ReferenceError', 'TypeError'],
};
