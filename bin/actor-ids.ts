import { ApifyClient } from 'apify-client';

import { logger } from './logger.js';
import type { TestTarget } from './stdin-input.js';
import { CONFIG_FILE_NAME } from './utils/config/load-config.js';

type ActorGetter = Pick<ApifyClient, 'actor'>;

/** What the lib gets for each Actor in `ACTOR_BUILDS`: the target, plus the env var its tests run with. */
interface ActorBuildTarget extends TestTarget {
    testTokenEnvVar?: string;
}

interface WithTestTokensOptions {
    /** The env var each Actor's tests run with, by full name, as the config resolves it */
    testTokenEnvVars: Map<string, string>;
    env?: NodeJS.ProcessEnv;
    createClient?: (token: string) => ActorGetter;
}

/**
 * Hands each target the env var its tests run with, from the config, and adds the ID it is missing: the raw ID to
 * those listed by full name, e.g. by `get-actor-configs`, and the full name to those listed by raw ID. The lib matches
 * a test to its Actor by the ID the test names, so a target without either ID would skip the tests that name its
 * Actor by the other one. Each Actor is looked up with its own test token.
 *
 * Nothing here fails the run: `get-actor-configs` lists every Actor in the repository, also ones no platform test
 * uses. An Actor that isn't in the config, or whose token isn't set, gets a warning, and the lib fails only the tests
 * that need it. An Actor its token can't see keeps only the ID it was listed with, so a test that names it by that ID
 * still runs and fails on its own.
 */
export const withTestTokens = async (
    targets: TestTarget[],
    {
        testTokenEnvVars,
        env = process.env,
        createClient = (token) => new ApifyClient({ token }),
    }: WithTestTokensOptions,
): Promise<ActorBuildTarget[]> => {
    const clients = new Map<string, ActorGetter>();
    const clientFor = (tokenEnvVar: string) => {
        const token = env[tokenEnvVar];
        if (!token) return undefined;
        if (!clients.has(token)) clients.set(token, createClient(token));
        return clients.get(token);
    };

    const resolved = await Promise.all(
        targets.map(async (target): Promise<ActorBuildTarget> => {
            const { actorFullName, actorRawId } = target;
            if (actorFullName) {
                const testTokenEnvVar = testTokenEnvVars.get(actorFullName);
                if (!testTokenEnvVar) return target;
                if (actorRawId) return { ...target, testTokenEnvVar };
                // Without the token there's nothing to look it up with, the missing token is reported below
                const client = clientFor(testTokenEnvVar);
                const actor = client && (await client.actor(actorFullName).get());
                if (client && !actor) warnNotFound(actorFullName, testTokenEnvVar, 'its raw ID');
                return { ...target, testTokenEnvVar, ...(actor && { actorRawId: actor.id }) };
            }
            // The parser lets no target through without either ID. A raw ID doesn't say which token it belongs to,
            // so each test token in the config gets a try.
            for (const testTokenEnvVar of new Set(testTokenEnvVars.values())) {
                const actor = await clientFor(testTokenEnvVar)?.actor(actorRawId!).get();
                if (actor) {
                    const fullName = `${actor.username}/${actor.name}`;
                    return { ...target, actorFullName: fullName, testTokenEnvVar: testTokenEnvVars.get(fullName) };
                }
            }
            logger.warn(
                `Actor ${actorRawId} not found with any test token in ${CONFIG_FILE_NAME} that is set. Tests that ` +
                    `name it by its raw ID will fail, and those that name it by its full name will be skipped.`,
            );
            return target;
        }),
    );

    warnAboutMissingTokens(resolved, env);
    return resolved;
};

const warnNotFound = (actorId: string, tokenEnvVar: string, missingId: string) => {
    logger.warn(
        `Actor ${actorId} not found, or ${tokenEnvVar} can't access it. Tests that name it by ${missingId} ` +
            `will be skipped.`,
    );
};

/** One warning per Actor without a test token in the config, and one per env var that isn't set. */
const warnAboutMissingTokens = (targets: ActorBuildTarget[], env: NodeJS.ProcessEnv) => {
    const unset = new Map<string, string[]>();
    for (const { actorFullName, actorRawId, testTokenEnvVar } of targets) {
        const actorId = (actorFullName ?? actorRawId)!;
        if (!testTokenEnvVar) {
            // A raw ID nobody found is already reported where it was looked up
            if (actorFullName) {
                logger.warn(
                    `Actor ${actorId} is not in ${CONFIG_FILE_NAME}, so there is no token to test it with. Its ` +
                        `tests will fail.`,
                );
            }
        } else if (!env[testTokenEnvVar]) {
            unset.set(testTokenEnvVar, [...(unset.get(testTokenEnvVar) ?? []), actorId]);
        }
    }
    for (const [tokenEnvVar, actorIds] of unset) {
        logger.warn(`${tokenEnvVar} is not set, so the tests of ${actorIds.join(', ')} will fail.`);
    }
};
