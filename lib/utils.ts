import { ApifyClient } from 'apify-client';

/**
 * Gets prefilled values for a provided build or, if not provided, uses actor's
 * default build (this is usually `latest`).
 */
export const getActorPrefilledInput = async (
    apifyClient: ApifyClient,
    actorNameOrId: string,
    buildId: string | undefined,
) => {
    if (!buildId) {
        const actorInfo = await apifyClient.actor(actorNameOrId).get();

        const defaultBuildTag = actorInfo?.defaultRunOptions.build;

        const taggedBuild = actorInfo?.taggedBuilds?.[defaultBuildTag || ''];
        buildId = taggedBuild?.buildId;

        if (!buildId) {
            console.error(`Coudn't find default build for actor ${actorNameOrId}. Prefilled values will not be used.`);
            return {}
        }
    }

    const buildInfo = await apifyClient.build(buildId).get();

    const inputSchema = buildInfo?.actorDefinition?.input as {
        properties: Record<string, { prefill?: unknown }>
    } | undefined

    if (!inputSchema) {
        console.error(
            `Coudn't find input schema definition for actor ${actorNameOrId}, build ${buildId}.`,
            'Prefilled values will not be used',
        );
        return {}
    }

    const prefill: Record<string, unknown> = {};

    for (const [propertyName, propertyValue] of Object.entries(inputSchema.properties)) {
        if (propertyValue.prefill !== undefined) {
            prefill[propertyName] = propertyValue.prefill;
        }
    }

    return prefill;
};
