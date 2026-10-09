import { selectActors } from '../../actor-filtering.js';
import type { ActorConfig, ActorEnvVarConfig } from '../../types.js';
import { safeReadJsonObjectFile } from '../json-file.js';
import { type ExistingDir, ExistingFile, type RelativeDir } from '../path/repo-relative.js';
import { type ActorJsonPaths, readActorJson } from './actor-json.js';
import { parseConfigFile } from './parser.js';
import type { ValidatedActorConfig } from './structures/base.js';

export const CONFIG_FILE_NAME = 'apify-test-tools.config.json';

// Reading the config happens in three stages, each one swappable on its own:
//
//   1. file                -> plain object          (safeReadJsonObjectFile)
//   2. plain object        -> ValidatedActorConfig[] (parseConfigFile — picks a strategy, validates
//                                                    and normalizes; see ./parser.ts)
//   3. ValidatedActorConfig -> LoadedActorConfig    (loadActorConfig — reads .actor/actor.json)

// #region utils

const findOverlappingContextPaths = (contextPaths: RelativeDir[]): [RelativeDir, RelativeDir] | undefined => {
    for (let i = 0; i < contextPaths.length; i++) {
        for (let j = i + 1; j < contextPaths.length; j++) {
            if (contextPaths[i].contains(contextPaths[j]) || contextPaths[j].contains(contextPaths[i])) {
                return [contextPaths[i], contextPaths[j]];
            }
        }
    }
    return undefined;
};

// Downstream ActorConfig consumers still use "" for the repo root.
const legacyPath = (dir: RelativeDir): string => (dir.path === '.' ? '' : dir.path);

export interface LoadedActorConfig {
    actorFullName: string;
    folder: ExistingDir;
    tokenEnvVar: string;
    actorJson: ActorJsonPaths;
    dockerContextDir: RelativeDir;
    contextPaths: RelativeDir[];
    envVars?: Record<string, ActorEnvVarConfig>;
}

// #endregion

// #region stages

/** Stage 1 — the config file as a plain object, or a failure phrased for whoever wrote it. */
const readConfigFileContents = async (): Promise<Record<string, unknown>> => {
    let configFile: ExistingFile;
    try {
        configFile = new ExistingFile(CONFIG_FILE_NAME);
    } catch {
        throw new Error(
            `Config file "${CONFIG_FILE_NAME}" not found in the current directory. ` +
                `Please create one with the required actor entries.`,
        );
    }
    const file = safeReadJsonObjectFile(configFile);
    if (file.success) {
        return file.contents;
    }

    switch (file.reason) {
        case 'invalid-json':
            // TODO: support .jsonc
            throw new Error(`Config file "${CONFIG_FILE_NAME}" contains invalid JSON and cannot be parsed.`);
        // Valid JSON that isn't an object can't carry an "actors" array either.
        case 'not-an-object':
            throw new Error(`Config file "${CONFIG_FILE_NAME}" must have an "actors" array at the top level.`);
        default:
            throw new Error(
                `Config file "${CONFIG_FILE_NAME}" not found in the current directory. ` +
                    `Please create one with the required actor entries.`,
            );
    }
};

/**
 * Stage 3 — resolves one normalized entry against the repo, reading the actor's `.actor/actor.json`
 * for its `dockerContextDir` and deciding which paths count as the actor's context.
 */
export const loadActorConfig = (entry: ValidatedActorConfig): LoadedActorConfig => {
    const { folder } = entry;
    const actorJson = readActorJson(entry);
    const { dockerContextDir } = actorJson;
    const contextPaths = [...(entry.overrideActorContext ?? [dockerContextDir])];

    // The actor's own folder is always part of its context. When an explicit "overrideActorContext"
    // doesn't already cover it, add it automatically instead of failing the workflow.
    if (!contextPaths.some((contextPath) => contextPath.contains(folder))) {
        contextPaths.push(folder);
    }

    const overlap = findOverlappingContextPaths(contextPaths);
    if (overlap) {
        throw new Error(
            `Invalid context paths for folder "${folder}" in "${CONFIG_FILE_NAME}": ` +
                `"${overlap[0]}" and "${overlap[1]}" overlap. Context paths must not be prefixes of one another.`,
        );
    }

    return {
        actorFullName: entry.actorFullName,
        folder: entry.folder,
        tokenEnvVar: entry.tokenEnvVar,
        actorJson,
        dockerContextDir,
        contextPaths,
        envVars: entry.envVars,
    };
};

const toLegacyActorConfig = (entry: LoadedActorConfig): ActorConfig => ({
    actorFullName: entry.actorFullName,
    folder: legacyPath(entry.folder),
    tokenEnvVar: entry.tokenEnvVar,
    dockerContextDir: legacyPath(entry.dockerContextDir),
    contextPaths: entry.contextPaths.map(legacyPath),
    envVars: entry.envVars,
});

// #endregion

export const readConfigFile = async (selection: { actors: string[]; ignore: string[] }): Promise<ActorConfig[]> => {
    const rawFileContents = await readConfigFileContents();
    const parsedConfigs = parseConfigFile(rawFileContents);

    const actorConfigs: ActorConfig[] = [];
    for (const parsed of parsedConfigs) {
        // Sequential on purpose: the first actor with a problem should be the one reported.
        actorConfigs.push(toLegacyActorConfig(loadActorConfig(parsed)));
    }

    return selectActors(selection, actorConfigs);
};
