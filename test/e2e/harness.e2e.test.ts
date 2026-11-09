import path from 'node:path';

import { describe, expect as vitestExpect } from 'vitest';

import { useHarness } from '../../index.js';
import { ActorSource } from '../../lib/harness.js';
import { projectRoot, token } from './helpers.js';

// The Actor's code. Self-contained by contract: `ActorSource.main` type-checks it on its own.
export const main = async () => {
    const { ApifyClient } = await import('apify-client');
    const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
    await client.dataset(process.env.ACTOR_DEFAULT_DATASET_ID!).pushItems([{ hello: 'world' }]);
};

describe.runIf(token)('harness', () => {
    const { test, createActor } = useHarness({ token: token!, namePrefix: 'test-tools-e2e' });
    const source = ActorSource.dirs(path.join(projectRoot, 'test/fixtures/harness-actor')).main(
        import.meta.filename,
        main,
    );

    test(
        'builds the inline Actor, runs it and reuses the Actor next time',
        async ({ expect, runActor }) => {
            const actor = await createActor('harness', { source });
            const result = await runActor(actor);

            // Not a crawler: no statistics record, so the stats-based checks are off.
            await expect(result).toFinishWith({
                datasetItemCount: 1,
                duration: null,
                failedRequests: null,
                requestsRetries: null,
            });
            expect((await result.getDataset()).items).toEqual([{ hello: 'world' }]);

            const again = await createActor('harness', { source });
            vitestExpect(again.id).toBe(actor.id);
        },
        { timeout: 15 * 60_000 },
    );
});
