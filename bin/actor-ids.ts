import { ApifyClient } from 'apify-client';

import { logger } from './logger.js';
import type { TestTarget } from './stdin-input.js';

export type ActorGetter = Pick<ApifyClient, 'actor'>;

/**
 * Adds the ID each target is missing: the raw ID to those listed by full name, e.g. by `get-actor-configs`, and the
 * full name to those listed by raw ID. The lib matches a test to its Actor by the ID the test names, so a target
 * without either ID would skip the tests that name its Actor by the other one.
 *
 * An Actor the token can't see keeps only the ID it was listed with, with a warning, rather than failing the run:
 * `get-actor-configs` lists every Actor in the repository, also ones no platform test uses, such as Actors the tester
 * account was never given access to. A test that names it by the listed ID still runs and fails on its own.
 */
export const withActorIds = async (
    targets: TestTarget[],
    client: ActorGetter = new ApifyClient({ token: process.env.TESTER_APIFY_TOKEN }),
): Promise<TestTarget[]> =>
    Promise.all(
        targets.map(async (target) => {
            const { actorFullName, actorRawId } = target;
            if (actorFullName && actorRawId) return target;
            // The parser lets no target through without either ID
            const actorId = (actorFullName ?? actorRawId)!;
            const actor = await client.actor(actorId).get();
            if (!actor) {
                logger.warn(
                    `Actor ${actorId} not found, or TESTER_APIFY_TOKEN can't access it. Tests that name it by ` +
                        `${actorFullName ? 'its raw ID' : 'its full name'} will be skipped.`,
                );
                return target;
            }
            return {
                ...target,
                actorFullName: actorFullName ?? `${actor.username}/${actor.name}`,
                actorRawId: actorRawId ?? actor.id,
            };
        }),
    );
