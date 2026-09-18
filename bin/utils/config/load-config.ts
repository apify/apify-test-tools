import path from 'node:path';

import { z } from 'zod';

import { selectActors } from '../../actor-filtering.js';
import { isPathWithinScope } from '../../path-utils.js';
import type { ActorConfig } from '../../types.js';
import { safeReadJsonObjectFile } from '../json-file.js';

export const CONFIG_FILE_NAME = 'apify-test-tools.config.json';

// Reading the config happens in four stages, each one swappable on its own:
//
//   1. file                -> plain object          (safeReadJsonObjectFile)
//   2. plain object        -> ActorConfigFile       (parseConfigFile — the schema, swap point for new flavours)
//   3. ActorConfigFile     -> ResolvedActorConfig[] (resolveRawConfig — one normalized shape for everyone)
//   4. ResolvedActorConfig -> ActorConfig           (loadActorConfig — merges in .actor/actor.json)
//
// Stages 1-3 are the "what did the user write" half and stage 4 the "what does the repo look like"
// half. A differently shaped config file only has to reach stage 3's output to work with the rest
// of the tool.

// #region schema (soon to be moved)

const ACTOR_ENTRY_SCHEMA = z.object({
    folder: z.string(),
    // "owner/name", with neither half empty — deliberately permissive about what characters those
    // halves may contain, the platform is the authority on that.
    actorFullName: z.string().regex(/^[^/]+\/[^/]+$/),
    tokenEnvVar: z.string(),
    overrideActorContext: z.array(z.string()).optional(),
});

const CONFIG_FILE_SCHEMA = z.object({
    actors: z.array(ACTOR_ENTRY_SCHEMA),
});

export type ActorConfigFile = z.infer<typeof CONFIG_FILE_SCHEMA>;

/**
 * The single shape stage 4 understands: an actor entry whose paths have been normalized, with no
 * trace left of which config flavour produced it. Whatever replaces or extends
 * {@link parseConfigFile} and {@link resolveRawConfig} only has to produce this.
 */
export interface ResolvedActorConfig {
    actorFullName: string;
    folder: string;
    tokenEnvVar: string;
    overrideActorContext?: string[];
}

// #endregion

// #region utils

// Strips a trailing slash so config-declared paths ("actors/shopify/" vs "actors/shopify") compare equal.
const stripTrailingSlash = (pathValue: string): string => pathValue.replace(/\/+$/, '');

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

type ConfigParsingIssue = z.ZodError<ActorConfigFile>['issues'][number];

// Restates a schema violation in the wording this config file has always used, so error output
// stays recognizable now that the hand-rolled checks are gone.
const describeIssue = (issue: ConfigParsingIssue, rawActors: unknown[]): string => {
    const [, index, field] = issue.path;

    if (typeof index !== 'number') {
        return `Config file "${CONFIG_FILE_NAME}" must have an "actors" array at the top level.`;
    }

    const folder = (rawActors[index] as { folder?: unknown } | undefined)?.folder;

    switch (field) {
        case 'folder':
            return (
                `Invalid "folder" for actor entry at index ${index} in "${CONFIG_FILE_NAME}". ` +
                `Must be a string (use "." for a single-actor repo).`
            );
        case 'actorFullName':
            return (
                `Invalid "actorFullName" for folder "${folder}" in "${CONFIG_FILE_NAME}". ` +
                `Must be in "owner/name" format (e.g. "apify/web-scraper").`
            );
        case 'tokenEnvVar':
            return `Invalid "tokenEnvVar" for folder "${folder}" in "${CONFIG_FILE_NAME}". Must be a string.`;
        case 'overrideActorContext':
            return (
                `Invalid "overrideActorContext" for folder "${folder}" in "${CONFIG_FILE_NAME}". ` +
                `Must be an array of strings.`
            );
        default:
            return `Invalid actor entry at index ${index} in "${CONFIG_FILE_NAME}": ${issue.message}`;
    }
};

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
 * Stage 2 — validates the file's shape. Every problem is reported at once rather than only the
 * first one to fail.
 */
export const parseConfigFile = (contents: Record<string, unknown>): ActorConfigFile => {
    const parsed = CONFIG_FILE_SCHEMA.safeParse(contents);
    if (parsed.success) {
        return parsed.data;
    }

    const rawActors = Array.isArray(contents.actors) ? contents.actors : [];
    const messages = new Set(parsed.error.issues.map((issue) => describeIssue(issue, rawActors)));
    throw new Error([...messages].join('\n'));
};

/**
 * Stage 3 — normalizes the paths the user wrote and rejects entries that collide once normalized.
 * The repo root is "" from here on, however it was spelled in the file.
 */
export const resolveRawConfig = (config: ActorConfigFile): ResolvedActorConfig[] => {
    const seenFolders = new Set<string>();

    return config.actors.map((entry) => {
        const folder = entry.folder === '.' ? '' : stripTrailingSlash(entry.folder);

        if (seenFolders.has(folder)) {
            throw new Error(
                `Duplicate folder "${entry.folder}" in "${CONFIG_FILE_NAME}". Each actor must have a unique folder.`,
            );
        }
        seenFolders.add(folder);

        return {
            actorFullName: entry.actorFullName,
            folder,
            tokenEnvVar: entry.tokenEnvVar,
            overrideActorContext: entry.overrideActorContext?.map(stripTrailingSlash),
        };
    });
};

// The repo root is spelled "" internally but "." in a config file, so report it the way a reader
// would have written it.
const displayFolder = (folder: string): string => folder || '.';

/**
 * Stage 4 — resolves one normalized entry against the repo, reading the actor's `.actor/actor.json`
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
    const rawConfig = await readConfigFileContents();

    // replace this when enabling different file structures
    // some kind of strategy pattern seems appropriate here
    const resolvedConfigs = resolveRawConfig(parseConfigFile(rawConfig));

    const actorConfigs: ActorConfig[] = [];
    for (const resolved of resolvedConfigs) {
        // Sequential on purpose: the first actor with a problem should be the one reported.
        actorConfigs.push(loadActorConfig(resolved));
    }

    return selectActors(selection, actorConfigs);
};
