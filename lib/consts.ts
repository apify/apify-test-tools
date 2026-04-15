import type { ToFinishWithOptionsWithDefaults } from './types.js';

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

/**
 * Both the test runs and the vitest test specs should finish in this time - 1 hour
 */
export const DEFAULT_TEST_RUN_DURATION_MS = 60 * 60 * 1000; // 1 hour
