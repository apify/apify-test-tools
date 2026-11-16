import { logger } from './logger.js';
import type { TestTarget } from './stdin-input.js';
import { CONFIG_FILE_NAME } from './utils/config/load-config.js';

/**
 * The token the tests of an Actor fall back to when its own isn't set, or it isn't in the config. Kept until every
 * caller passes the Actors' tokens: the lib does the same.
 */
export const FALLBACK_TOKEN_ENV_VAR = 'TESTER_APIFY_TOKEN';

/** What the lib gets for each Actor in `ACTOR_BUILDS`: the target and the env var its tests run with. */
interface ActorBuildTarget extends TestTarget {
    testTokenEnvVar?: string;
}

interface WithTestTokensOptions {
    /** The env var each Actor's tests run with, by full name, as the config resolves it */
    testTokenEnvVars: Map<string, string>;
    env?: NodeJS.ProcessEnv;
}

/**
 * Hands each target the env var its tests run with, from the config.
 *
 * Nothing here fails the run: `get-actor-configs` lists every Actor in the repository, also ones no platform test
 * uses. An Actor that isn't in the config, or whose token isn't set, gets a warning, and the lib runs its tests with
 * `TESTER_APIFY_TOKEN`, or fails only them without it.
 */
export const withTestTokens = (
    targets: TestTarget[],
    { testTokenEnvVars, env = process.env }: WithTestTokensOptions,
): ActorBuildTarget[] => {
    const resolved = targets.map((target): ActorBuildTarget => {
        const testTokenEnvVar = testTokenEnvVars.get(target.actorFullName);
        return { ...target, ...(testTokenEnvVar && { testTokenEnvVar }) };
    });
    warnAboutMissingTokens(resolved, env);
    return resolved;
};

/** One warning per Actor without a test token in the config, and one per env var that isn't set. */
const warnAboutMissingTokens = (targets: ActorBuildTarget[], env: NodeJS.ProcessEnv) => {
    const outcome = env[FALLBACK_TOKEN_ENV_VAR] ? `run with ${FALLBACK_TOKEN_ENV_VAR}` : 'will fail';
    const unset = new Map<string, string[]>();
    for (const { actorFullName, testTokenEnvVar } of targets) {
        if (!testTokenEnvVar) {
            logger.warn(`Actor ${actorFullName} is not in ${CONFIG_FILE_NAME}, so its tests ${outcome}.`);
        } else if (!env[testTokenEnvVar]) {
            unset.set(testTokenEnvVar, [...(unset.get(testTokenEnvVar) ?? []), actorFullName]);
        }
    }
    for (const [tokenEnvVar, actorIds] of unset) {
        logger.warn(`${tokenEnvVar} is not set, so the tests of ${actorIds.join(', ')} ${outcome}.`);
    }
};
