import { dirname, join, normalize } from 'node:path';

import z from 'zod';

import { selectActors } from '../actor-filtering.js';
import type { ActorConfig } from '../types.js';
import { type ActorJson, getActorJsonPath, parseActorJsonAndResolvePaths } from './actor-json.js';
import { safeReadJsonObjectFile } from './files.js';

export const DEFAULT_CONFIG_FILE_PATH = 'apify-test-tools.config.json';

// #region schema

const TEST_UTILS_ACTOR_SCHEMA = z.object({
    folder: z.string().nonempty(),
    actorFullName: z.string().regex(/^[\w-]+\/[\w-]+$/),
    tokenEnvVar: z.string().nonempty(),
    overrideActorContext: z.array(z.string()).nonempty().optional(),
});
export type TestUtilsActor = z.infer<typeof TEST_UTILS_ACTOR_SCHEMA>;

const ACTOR_CONFIG_SCHEMA = z.object({
    actors: z.array(TEST_UTILS_ACTOR_SCHEMA),
});

export type TestUtilsConfig = z.infer<typeof ACTOR_CONFIG_SCHEMA>;
// #endregion

// #region utils
/**
 * Ensures each actor has a unique name.
 * If not, throws an error listing all duplicates.
 * @param actorConfigs ActorConfig[]
 * @returns void
 * @throws Error
 */
function enforceUniqueActorFullNames(actorConfigs: ActorConfig[]): void {
    const fullNamesCount = actorConfigs.reduce(
        (acc, c) => {
            acc[c.actorFullName] = (acc[c.actorFullName] ?? 0) + 1;
            return acc;
        },
        {} as Record<string, number>,
    );
    const duplicates = Object.entries(fullNamesCount).filter(([_, count]) => count > 1);
    if (duplicates.length === 0) return;

    throw new Error(
        `Duplicate actor full names on the following actors in "${DEFAULT_CONFIG_FILE_PATH}": \n${duplicates.map(([name]) => name).join('\n')}`,
    );
}
/**
 * Resolves the `folder` and `overrideActorContext` fields of each actor in the config.
 * @param config the config to resolve
 * @param path the path to resolve against
 * @returns the config with resolved paths
 */
function resolveConfigFilePaths(config: TestUtilsConfig, path: string): TestUtilsConfig {
    for (const actorConfig of config.actors) {
        actorConfig.folder = join(path, actorConfig.folder);
        if (actorConfig.overrideActorContext) {
            actorConfig.overrideActorContext = actorConfig.overrideActorContext.map((p) => join(path, p));
        }
    }
    return config;
}
/**
 * Adds `actor.json` fields to the base config, producing a full `ActorConfig`.
 *
 * Additionally, decides the `contextPaths` field based on the `overrideActorContext` field
 * or the `dockerContextDir` field if no override is set.
 * @param config the base config for a single actor
 * @param actorConfig `actor.json` contents
 * @returns `ActorConfig`
 */
function mergeActorConfig(config: TestUtilsActor, actorConfig: ActorJson): ActorConfig {
    return {
        ...config,
        actorConfig,
        contextPaths: config.overrideActorContext?.map((p) => normalize(p)) ?? [actorConfig.dockerContextDir],
        dockerContextDir: actorConfig.dockerContextDir,
    };
}

export const testablePrivates = {
    enforceUniqueActorFullNames,
    resolveConfigFilePaths,
    mergeActorConfig,
};

// #endregion

// #region exports
export const readConfigFile = async (
    selection: { actors: string[]; ignore: string[] },
    configFilePath: string = DEFAULT_CONFIG_FILE_PATH,
): Promise<ActorConfig[]> => {
    const file = await safeReadJsonObjectFile(configFilePath);
    if (!file.success) {
        throw file.failure;
    }
    const parsed = ACTOR_CONFIG_SCHEMA.safeParse(file.contents);
    if (!parsed.success) {
        throw new Error(`Config file is not valid. See errors below\n${z.prettifyError(parsed.error)}`);
    }

    const resolvedConfig = resolveConfigFilePaths(parsed.data, dirname(configFilePath));
    const results = await Promise.all(resolvedConfig.actors.map(loadActorConfig));

    enforceUniqueActorFullNames(results);
    const selectedActors = selectActors(selection, results);
    return selectedActors;
};

export async function loadActorConfig(config: TestUtilsActor): Promise<ActorConfig> {
    const actorJsonPath = getActorJsonPath(config.folder);
    const actorJsonFile = await safeReadJsonObjectFile(actorJsonPath);
    if (!actorJsonFile.success) {
        throw actorJsonFile.failure;
    }
    const actorJson = parseActorJsonAndResolvePaths(actorJsonFile.contents, actorJsonPath);
    return mergeActorConfig(config, actorJson);
}
// #endregion
