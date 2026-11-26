interface ConfigActor {
    buildTokenEnvVar?: string;
    testTokenEnvVar?: string;
    [key: string]: unknown;
}

/**
 * A `grouped` config with all the Actors in one group, each keeping its own `buildTokenEnvVar` and testing with it
 * unless it sets its own `testTokenEnvVar`. The group's tokens, which the group requires, are the first Actor's.
 */
export const groupedConfig = (actors: ConfigActor[], settings: Record<string, unknown> = {}) => {
    const groupToken = actors[0]?.buildTokenEnvVar ?? 'APIFY_TOKEN';
    return {
        mode: 'grouped',
        ...settings,
        groups: {
            actors: {
                buildTokenEnvVar: groupToken,
                testTokenEnvVar: actors[0]?.testTokenEnvVar ?? groupToken,
                actors: actors.map((actor) =>
                    actor.buildTokenEnvVar && !actor.testTokenEnvVar
                        ? { ...actor, testTokenEnvVar: actor.buildTokenEnvVar }
                        : actor,
                ),
            },
        },
    };
};
