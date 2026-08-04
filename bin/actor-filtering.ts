import type { ActorConfig, Config } from './types.js';

export function filterActorByConfig(config: Config, actorConfig: ActorConfig[]) {
    const fullNames = actorConfig.map((x) => x.actorFullName);

    const missingOmitActors = config.omitActors.filter((name) => !fullNames.includes(name));
    const missingOnlyActors = config.onlyActors.filter((name) => !fullNames.includes(name));

    if (missingOmitActors.length > 0 || missingOnlyActors.length > 0) {
        const missing = [...missingOmitActors, ...missingOnlyActors];
        console.error(`[ERROR]: The following actors from the filter config do not exist: ${missing.join(', ')}`);
        process.exit(1);
    }

    const actorsAfterOnly = config.onlyActors.length
        ? actorConfig.filter((actor) => config.onlyActors.includes(actor.actorFullName))
        : actorConfig;
    const actorsAfterOmit = actorsAfterOnly.filter((actor) => !config.omitActors.includes(actor.actorFullName));

    return actorsAfterOmit;
}
