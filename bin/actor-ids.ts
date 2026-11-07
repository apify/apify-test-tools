import { ApifyClient } from 'apify-client';

import { logger } from './logger.js';
import type { TestTarget } from './stdin-input.js';
import { CONFIG_FILE_NAME } from './utils/config/load-config.js';

type ActorGetter = Pick<ApifyClient, 'actor'>;

/**
 * The token the tests of an Actor fall back to when its own isn't set, or it isn't in the config. Kept until every
 * repository runs a lib that reads `testTokenEnvVar` and every caller passes the Actors' tokens: the lib does the same.
 */
export const FALLBACK_TOKEN_ENV_VAR = 'TESTER_APIFY_TOKEN';

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
 * Actor by the other one. Each Actor is looked up with the token its tests run with: its own test token, or
 * `TESTER_APIFY_TOKEN` when that isn't set.
 *
 * Nothing here fails the run: `get-actor-configs` lists every Actor in the repository, also ones no platform test
 * uses. An Actor that isn't in the config, or whose token isn't set, gets a warning, and the lib runs its tests with
 * `TESTER_APIFY_TOKEN`, or fails only them without it. An Actor its token can't see keeps only the ID it was listed
 * with, so a test that names it by that ID still runs and fails on its own.
 */
export const withTestTokens = async (
    targets: TestTarget[],
    {
        testTokenEnvVars,
        env = process.env,
        createClient = (token) => new ApifyClient({ token }),
    }: WithTestTokensOptions,
): Promise<ActorBuildTarget[]> => {
    /** The env var the tests of an Actor end up with, as the lib picks it */
    const effectiveEnvVar = (testTokenEnvVar?: string) => {
        if (testTokenEnvVar && env[testTokenEnvVar]) return testTokenEnvVar;
        return env[FALLBACK_TOKEN_ENV_VAR] ? FALLBACK_TOKEN_ENV_VAR : undefined;
    };
    const clients = new Map<string, ActorGetter>();
    const clientFor = (tokenEnvVar: string) => {
        const token = env[tokenEnvVar]!;
        if (!clients.has(token)) clients.set(token, createClient(token));
        return clients.get(token)!;
    };

    const resolved = await Promise.all(
        targets.map(async (target): Promise<ActorBuildTarget> => {
            const { actorFullName, actorRawId } = target;
            if (actorFullName) {
                const testTokenEnvVar = testTokenEnvVars.get(actorFullName);
                const withToken = { ...target, ...(testTokenEnvVar && { testTokenEnvVar }) };
                if (actorRawId) return withToken;
                // Without any token there's nothing to look it up with, the missing token is reported below
                const lookupEnvVar = effectiveEnvVar(testTokenEnvVar);
                if (!lookupEnvVar) return withToken;
                const actor = await clientFor(lookupEnvVar).actor(actorFullName).get();
                if (!actor) warnNotFound(actorFullName, lookupEnvVar, 'its raw ID');
                return { ...withToken, ...(actor && { actorRawId: actor.id }) };
            }
            // The parser lets no target through without either ID. A raw ID doesn't say which token it belongs to,
            // so each test token in the config that is set gets a try, and then the fallback.
            const candidates = new Set(
                [...testTokenEnvVars.values(), FALLBACK_TOKEN_ENV_VAR].filter((tokenEnvVar) => env[tokenEnvVar]),
            );
            for (const lookupEnvVar of candidates) {
                const actor = await clientFor(lookupEnvVar).actor(actorRawId!).get();
                if (actor) {
                    const fullName = `${actor.username}/${actor.name}`;
                    const testTokenEnvVar = testTokenEnvVars.get(fullName);
                    return { ...target, actorFullName: fullName, ...(testTokenEnvVar && { testTokenEnvVar }) };
                }
            }
            logger.warn(
                `Actor ${actorRawId} not found with any test token in ${CONFIG_FILE_NAME} that is set, nor with ` +
                    `${FALLBACK_TOKEN_ENV_VAR}. Tests that name it by its full name will be skipped.`,
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
    const outcome = env[FALLBACK_TOKEN_ENV_VAR] ? `run with ${FALLBACK_TOKEN_ENV_VAR}` : 'will fail';
    const unset = new Map<string, string[]>();
    for (const { actorFullName, actorRawId, testTokenEnvVar } of targets) {
        const actorId = (actorFullName ?? actorRawId)!;
        if (!testTokenEnvVar) {
            // A raw ID nobody found is already reported where it was looked up
            if (actorFullName) {
                logger.warn(`Actor ${actorId} is not in ${CONFIG_FILE_NAME}, so its tests ${outcome}.`);
            }
        } else if (!env[testTokenEnvVar]) {
            unset.set(testTokenEnvVar, [...(unset.get(testTokenEnvVar) ?? []), actorId]);
        }
    }
    for (const [tokenEnvVar, actorIds] of unset) {
        logger.warn(`${tokenEnvVar} is not set, so the tests of ${actorIds.join(', ')} ${outcome}.`);
    }
};
