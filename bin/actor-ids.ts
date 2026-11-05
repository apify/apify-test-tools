import { ApifyClient } from 'apify-client';

import type { TestTarget } from './stdin-input.js';

type ActorGetter = Pick<ApifyClient, 'actor'>;

/** A test target with both IDs of its Actor */
export type ResolvedTestTarget = TestTarget & { actorFullName: string; actorRawId: string };

/**
 * Adds the ID each target is missing: the raw ID to those listed by full name, e.g. by `get-actor-configs`, and the
 * full name to those listed by raw ID. The lib matches a test to its Actor by the ID the test names, so a target
 * without either ID would skip the tests that name its Actor by the other one.
 */
export const withActorIds = async (
    targets: TestTarget[],
    client: ActorGetter = new ApifyClient({ token: process.env.TESTER_APIFY_TOKEN }),
): Promise<ResolvedTestTarget[]> =>
    Promise.all(
        targets.map(async (target) => {
            const { actorFullName, actorRawId } = target;
            if (actorFullName && actorRawId) return { ...target, actorFullName, actorRawId };
            // The parser lets no target through without either ID
            const actorId = (actorFullName ?? actorRawId)!;
            const actor = await client.actor(actorId).get();
            if (!actor) {
                throw new Error(
                    `Actor ${actorId} not found, or TESTER_APIFY_TOKEN can't access it. ` +
                        'Both its full name and its raw ID are needed to run the tests that name it by either.',
                );
            }
            return {
                ...target,
                actorFullName: actorFullName ?? `${actor.username}/${actor.name}`,
                actorRawId: actorRawId ?? actor.id,
            };
        }),
    );
