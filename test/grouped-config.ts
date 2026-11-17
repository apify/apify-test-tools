interface ConfigActor {
    tokenEnvVar?: string;
    [key: string]: unknown;
}

/**
 * A `grouped` config with all the Actors in one group, each keeping its own `tokenEnvVar`. The group's token is the
 * first Actor's, which the group requires.
 */
export const groupedConfig = (actors: ConfigActor[], settings: Record<string, unknown> = {}) => ({
    mode: 'grouped',
    ...settings,
    groups: { actors: { tokenEnvVar: actors[0]?.tokenEnvVar ?? 'APIFY_TOKEN', actors } },
});
