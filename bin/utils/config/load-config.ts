import path from 'node:path';

import { selectActors } from '../../actor-filtering.js';
import { isPathWithinScope } from '../../path-utils.js';
import type { ActorConfig } from '../../types.js';
import { safeReadJsonObjectFile } from '../json-file.js';
import { parseConfigFile } from './parser.js';
import type { ResolvedActorConfig } from './structures/base.js';

export const CONFIG_FILE_NAME = 'apify-test-tools.config.json';

// Reading the config happens in three stages, each one swappable on its own:
//
//   1. file                -> plain object          (safeReadJsonObjectFile)
//   2. plain object        -> ResolvedActorConfig[] (parseConfigFile — picks a strategy, validates
//                                                    and normalizes; see ./parser.ts)
//   3. ResolvedActorConfig -> ActorConfig           (loadActorConfig — merges in .actor/actor.json)

// #region utils

const findOverlappingContextPaths = (contextPaths: string[]): [string, string] | undefined => {
    for (let i = 0; i < contextPaths.length; i++) {
        for (let j = i + 1; j < contextPaths.length; j++) {
            if (
                isPathWithinScope(contextPaths[i], contextPaths[j]) ||
                isPathWithinScope(contextPaths[j], contextPaths[i])
            ) {
                return [contextPaths[i], contextPaths[j]];
            }
        }
    }
    return undefined;
};

// The repo root is spelled "" internally but "." in a config file, so report it the way a reader
// would have written it.
const displayFolder = (folder: string): string => folder || '.';

// #endregion

// #region stages

/** Stage 1 — the config file as a plain object, or a failure phrased for whoever wrote it. */
const readConfigFileContents = async (): Promise<Record<string, unknown>> => {
    const file = safeReadJsonObjectFile(CONFIG_FILE_NAME);
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
export const loadActorConfig = (entry: ResolvedActorConfig): ActorConfig => {
    const { folder } = entry;
    const actorJsonPath = folder ? `${folder}/.actor/actor.json` : '.actor/actor.json';

    const actorJson = safeReadJsonObjectFile(actorJsonPath);
    if (!actorJson.success) {
        throw new Error(
            `Cannot read "${actorJsonPath}". Every actor entry in "${CONFIG_FILE_NAME}" ` +
                `must have a corresponding .actor/actor.json file.`,
        );
    }

    const actorDotDir = folder ? `${folder}/.actor` : '.actor';
    const rawDockerContextDir =
        typeof actorJson.contents.dockerContextDir === 'string' ? actorJson.contents.dockerContextDir : '..';
    const resolved = path.resolve(process.cwd(), actorDotDir, rawDockerContextDir);
    const dockerContextDir = path.relative(process.cwd(), resolved);

    if (dockerContextDir.startsWith('..')) {
        throw new Error(
            `"dockerContextDir" for folder "${displayFolder(folder)}" resolves outside the repository root. ` +
                `Resolved path: "${dockerContextDir}".`,
        );
    }

    const normalizedDockerContextDir = dockerContextDir === '.' ? '' : dockerContextDir;
    const contextPaths = [...(entry.overrideActorContext ?? [normalizedDockerContextDir])];

    // The actor's own folder is always part of its context. When an explicit "overrideActorContext"
    // doesn't already cover it, add it automatically instead of failing the workflow.
    if (!contextPaths.some((contextPath) => isPathWithinScope(folder, contextPath))) {
        contextPaths.push(folder);
    }

    const overlap = findOverlappingContextPaths(contextPaths);
    if (overlap) {
        throw new Error(
            `Invalid context paths for folder "${displayFolder(folder)}" in "${CONFIG_FILE_NAME}": ` +
                `"${overlap[0]}" and "${overlap[1]}" overlap. Context paths must not be prefixes of one another.`,
        );
    }

    return {
        actorFullName: entry.actorFullName,
        folder,
        tokenEnvVar: entry.tokenEnvVar,
        dockerContextDir: normalizedDockerContextDir,
        contextPaths,
    };
};

// #endregion

export const readConfigFile = async (selection: { actors: string[]; ignore: string[] }): Promise<ActorConfig[]> => {
    const rawFileContents = await readConfigFileContents();
    const parsedConfigs = parseConfigFile(rawFileContents);

    const actorConfigs: ActorConfig[] = [];
    for (const parsed of parsedConfigs) {
        // Sequential on purpose: the first actor with a problem should be the one reported.
        actorConfigs.push(loadActorConfig(parsed));
    }

    return selectActors(selection, actorConfigs);
};
