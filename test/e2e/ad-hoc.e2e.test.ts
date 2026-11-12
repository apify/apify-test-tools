import path from 'node:path';

import { describe, vi } from 'vitest';

// The lib reads the tester token when it's imported; the e2e suites get theirs under the sandbox's own name.
vi.hoisted(() => {
    process.env.TESTER_APIFY_TOKEN ??= process.env.E2E_TEST_APIFY_TOKEN_DBYPODOIHUZABNQTR;
});

// eslint-disable-next-line import/first
import { buildActor, defineActor, testActor } from '../../index.js';
// eslint-disable-next-line import/first
import { ActorSource } from '../../lib/ad-hoc.js';
// eslint-disable-next-line import/first
import { projectRoot, token } from './helpers.js';

// The Actor's code. Self-contained by contract: `ActorSource.main` type-checks it on its own.
export const main = async () => {
    const { ApifyClient } = await import('apify-client');
    const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
    await client.dataset(process.env.ACTOR_DEFAULT_DATASET_ID!).pushItems([{ hello: 'world' }]);
};

describe.runIf(token)('ad-hoc Actor', () => {
    const actor = defineActor('test-tools-e2e-ad-hoc', {
        source: ActorSource.dirs(path.join(projectRoot, 'test/fixtures/ad-hoc-actor')).main(import.meta.filename, main),
        syncDelayMs: 0,
    });

    testActor(
        actor,
        'is built from its source once and run on that build',
        async ({ expect, run }) => {
            const [first, second] = await Promise.all([run(), run()]);

            // Not a crawler: no statistics record, so the stats-based checks are off.
            await expect(first).toFinishWith({
                datasetItemCount: 1,
                duration: null,
                failedRequests: null,
                requestsRetries: null,
            });
            expect.hard((await second.getDataset()).items).toEqual([{ hello: 'world' }]);

            const { buildNumber } = await buildActor(actor);
            expect.hard((await first.getRunInfo()).buildNumber).toBe(buildNumber);
            expect.hard((await second.getRunInfo()).buildNumber).toBe(buildNumber);
        },
        { timeout: 15 * 60_000, retry: 0 },
    );
});
