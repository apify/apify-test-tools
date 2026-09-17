import type { ActorVersionClient } from 'apify-client';
import { ApifyApiError } from 'apify-client';

import type { ActorConfig } from './types.js';

export type ResolvedActorEnvVar = {
    name: string;
    value: string;
    isSecret: boolean;
};

export const resolveActorEnvVars = (
    actorConfig: ActorConfig,
    isLatest: boolean,
    env: NodeJS.ProcessEnv,
): ResolvedActorEnvVar[] => {
    const resolved: ResolvedActorEnvVar[] = [];

    for (const [name, definition] of Object.entries(actorConfig.envVars ?? {})) {
        if (!isLatest && !definition.isShared) continue;

        const value = env[definition.fromEnv];
        if (!value) {
            throw new Error(`Missing environment variable value for Actor ${actorConfig.actorFullName}, ${name}.`);
        }

        resolved.push({ name, value, isSecret: definition.isSecret });
    }

    return resolved;
};

export const logSelectedActorEnvVars = (actorConfig: ActorConfig, isLatest: boolean): void => {
    for (const [name, definition] of Object.entries(actorConfig.envVars ?? {})) {
        if (!isLatest && definition.isShared !== true) continue;
        console.error(
            `    ${name} <- ${definition.fromEnv} (isSecret: ${definition.isSecret}, isShared: ${definition.isShared === true})`,
        );
    }
};

export const syncActorEnvVars = async (
    versionClient: ActorVersionClient,
    variables: ResolvedActorEnvVar[],
    actorFullName: string,
): Promise<void> => {
    for (const { name, value, isSecret } of variables) {
        const variableClient = versionClient.envVar(name);
        try {
            if (await variableClient.get()) {
                await variableClient.update({ value, isSecret });
                continue;
            }

            try {
                await versionClient.envVars().create({ name, value, isSecret });
            } catch (error) {
                if (!(error instanceof ApifyApiError) || error.type !== 'env-var-already-exists') throw error;
                await variableClient.update({ value, isSecret });
            }
        } catch (error) {
            const status = error instanceof ApifyApiError ? ` (status ${error.statusCode})` : '';
            throw new Error(`Failed to synchronize environment variable ${name} for Actor ${actorFullName}${status}.`);
        }
    }
};
