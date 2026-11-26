import { ACTOR_NAME, USERNAME } from '@apify/consts';

import type { ToFinishWithOptionsWithDefaults } from './types.js';

const stripRegexAnchors = (regex: RegExp) => regex.source.replace(/^\^/, '').replace(/\$$/, '');

/** An Actor's full name, `owner/name`, the only ID tests and the config name an Actor by */
export const ACTOR_FULL_NAME_REGEX = new RegExp(
    `^${stripRegexAnchors(USERNAME.REGEX)}/${stripRegexAnchors(ACTOR_NAME.REGEX)}$`,
    USERNAME.REGEX.flags + ACTOR_NAME.REGEX.flags,
);

/** A Crawlee crawler persists its statistics under one of these, followed by its statistics id */
export const STATISTICS_KEY_PREFIXES = ['SDK_CRAWLER_STATISTICS_', 'CRAWLEE_CRAWLER_STATISTICS_'] as const;

export const TO_FINISH_WITH_OPTIONS: ToFinishWithOptionsWithDefaults = {
    status: 'SUCCEEDED',
    duration: null,
    failedRequests: 0,
    requestsRetries: null,
    maxRetriesPerRequest: null,
    // An error as JavaScript prints it, `TypeError: <message>`, not the word in prose or in a longer name
    forbiddenLogs: [/\bReferenceError: /, /\bTypeError: /],
    // Every record under STATISTICS_KEY_PREFIXES
    statisticsKeys: undefined,
    strictChargedEventCounts: false,
};

/**
 * Both the test runs and the vitest test specs should finish in this time - 1 hour
 */
export const DEFAULT_TEST_RUN_DURATION_MS = 60 * 60 * 1000; // 1 hour

// Prevent orphaned runs - timeout the Actor 1 minute before the test does so everything is logged correctly.
//      - Otherwise the run link URL can get lost.
export const DEFAULT_TEST_ACTOR_TIMEOUT_SECS = DEFAULT_TEST_RUN_DURATION_MS / 1000 - 60;

/**
 * Delay before checking the dataset and statistics after a run finishes to resolve eventual consistency.
 * - This value should ensure that the dataset and statistics are fully updated before any assertions are made.
 * - Super rarely the platform is still not synced even after 10s, so 20s should be sufficient practically always.
 */
export const DATASET_SYNC_DELAY_MS = 20 * 1000; // 20 seconds
