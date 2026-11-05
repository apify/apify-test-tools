import { ApifyClient } from 'apify-client';

import type { TestTarget } from './stdin-input.js';

type ActorGetter = Pick<ApifyClient, 'actor'>;

/**
 * Adds the raw platform ID to each target that has none, e.g. those `get-actor-configs` lists. The lib matches a test
 * to its Actor by the ID the test names, the full name or the raw ID, so without it the tests that name their Actor by
 * raw ID would all be skipped.
 */
export const withActorRawIds = async (
    targets: TestTarget[],
    client: ActorGetter = new ApifyClient({ token: process.env.TESTER_APIFY_TOKEN }),
): Promise<TestTarget[]> =>
    Promise.all(
        targets.map(async (target) => {
            if (target.actorRawId) return target;
            const actor = await client.actor(target.actorFullName).get();
            if (!actor) {
                throw new Error(
                    `Actor ${target.actorFullName} not found, or TESTER_APIFY_TOKEN can't access it. ` +
                        'Its raw ID is needed to run the tests that name it by that ID.',
                );
            }
            return { ...target, actorRawId: actor.id };
        }),
    );
