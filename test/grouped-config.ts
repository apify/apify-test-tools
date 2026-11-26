interface ConfigActor {
    buildTokenEnvVar?: string;
    [key: string]: unknown;
}

/**
 * A `grouped` config with all the Actors in one group, each keeping its own `buildTokenEnvVar`. The group's token is the
 * first Actor's, which the group requires.
 */
export const groupedConfig = (actors: ConfigActor[], settings: Record<string, unknown> = {}) => ({
    mode: 'grouped',
    ...settings,
    groups: { actors: { buildTokenEnvVar: actors[0]?.buildTokenEnvVar ?? 'APIFY_TOKEN', actors } },
});
