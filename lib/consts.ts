import type { ToFinishWithOptionsWithDefaults } from './types';

export const TO_FINISH_WITH_OPTIONS: ToFinishWithOptionsWithDefaults = {
    status: 'SUCCEEDED',
    duration: {
        min: 600, // 0.6 sec
        max: 600_000, // 10 min
    },
    failedRequests: 0,
    requestsRetries: { max: 3 },
    forbiddenLogs: [
        'ReferenceError',
        'TypeError',
    ],
    maxRetriesPerRequest: null,
};
