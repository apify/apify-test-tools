import type { RunWhenConfig, ToFinishWithOptionsWithDefaults } from './types.js';

// Default trigger config.
// `Required<RunWhenConfig>` ensures a compile error when a new TriggerType is added,
// forcing an explicit opt-in/opt-out decision for existing tests.
// hourly is false by default — only specific directories (e.g. core/) run hourly,
// controlled via BACKWARD_COMPATIBLE_HOURLY_DIR.
export const DEFAULT_TRIGGERS: { runWhen: Required<RunWhenConfig> } = {
    runWhen: { hourly: false, daily: true, pullRequest: true },
};

export const DEFAULT_DESCRIBE_OPTIONS = {
    concurrent: true,
    timeout: 60_000 * 60,
};

export const DEFAULT_TEST_ACTOR_OPTIONS = {
    retry: 1,
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
