import { dirname, join, relative, resolve } from 'node:path';

import z from 'zod';

import { ACTOR_LIMITS } from '@apify/consts';

const DEFAULT_PATH = '.actor/actor.json';
// #region schema

const memoryMbytesSchema = z.int().min(ACTOR_LIMITS.MIN_RUN_MEMORY_MBYTES).max(ACTOR_LIMITS.MAX_RUN_MEMORY_MBYTES);

/** Matches `oneOf: [{ type: 'string' }, { type: 'object' }]` — an inline definition or a path to it. */
const stringOrObjectSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

const storagesSchema = z
    .strictObject({
        keyValueStore: stringOrObjectSchema.optional(),
        dataset: stringOrObjectSchema.optional(),
        datasets: z
            .record(z.string().regex(/^[A-Za-z]\w{0,100}$/), stringOrObjectSchema)
            .refine((datasets) => Object.keys(datasets).length >= 1 && Object.keys(datasets).length <= 10, {
                message: 'Expected between 1 and 10 datasets',
            })
            .refine((datasets) => 'default' in datasets, {
                message: 'Expected a `default` dataset',
            })
            .optional(),
    })
    // `dataset` and `datasets` are mutually exclusive
    .refine((storages) => !(storages.dataset !== undefined && storages.datasets !== undefined), {
        message: 'Expected only one of `dataset` or `datasets` to be set',
    });

export const ACTOR_JSON_SCHEMA = z.object({
    $schema: z.string().optional(),
    actorSpecification: z.literal(1),
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    version: z.string().regex(/^(\d+)\.(\d+)(\.\d+)?$/),
    buildTag: z.string().default('latest'),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    dockerfile: z.string().default('../Dockerfile'),
    // `dockerContextDir` is the only defaulted value that does not match the schema
    // Its done for simplicity in code (and also the platform assumes it anyway)
    dockerContextDir: z.string().default('..'),
    readme: z.string().default('../README.md'),
    changelog: z.string().optional(),
    minMemoryMbytes: memoryMbytesSchema.optional(),
    maxMemoryMbytes: memoryMbytesSchema.optional(),
    defaultMemoryMbytes: z.union([z.string(), memoryMbytesSchema]).optional(),
    input: stringOrObjectSchema.optional(),
    inputSchema: stringOrObjectSchema.optional(),
    output: stringOrObjectSchema.optional(),
    outputSchema: stringOrObjectSchema.optional(),
    storages: storagesSchema.optional(),
    usesStandbyMode: z.boolean().optional(),
    webServerSchema: stringOrObjectSchema.optional(),
    webServerMcpPath: z.string().optional(),
});

export type ActorJson = z.infer<typeof ACTOR_JSON_SCHEMA>;
// #endregion

// #region exports

/**
 * @param actorDir path to actor root folder
 * @returns full resolved path to actor.json on expected location
 */
export function getActorJsonPath(actorDir: string): string {
    return join(actorDir, DEFAULT_PATH);
}

/**
 * @param contents contents of actor.json already parsed, like from `safeReadJsonObjectFile`
 * @param path path to actor.json
 */
export function parseActorJsonAndResolvePaths(contents: Record<string, unknown>, path: string): ActorJson {
    const parsed = ACTOR_JSON_SCHEMA.safeParse(contents);
    if (!parsed.success) {
        throw new Error(`Actor.json is not valid. See errors below\n${z.prettifyError(parsed.error)}`);
    }
    return resolveActorJsonPaths(parsed.data, path);
}

const resolvePathIfPresent = <T>(base: string, to: T | string): string | T => {
    if (typeof to === 'string') {
        return join(base, to);
    }
    return to;
};

export function resolveActorJsonPaths(config: ActorJson, path: string): ActorJson {
    const base = path.endsWith('actor.json') ? dirname(path) : path;
    const result = structuredClone(config);
    result.dockerContextDir = join(base, config.dockerContextDir);
    result.readme = join(base, config.readme);
    result.changelog = resolvePathIfPresent(base, config.changelog);
    if (config.storages) {
        if (result.storages?.dataset) {
            result.storages.dataset = resolvePathIfPresent(base, config.storages.dataset);
        }
        if (result.storages?.keyValueStore) {
            result.storages.keyValueStore = resolvePathIfPresent(base, config.storages.keyValueStore);
        }
        if (result.storages?.datasets) {
            result.storages.datasets = Object.fromEntries(
                Object.entries(result.storages.datasets).map(([name, dataset]) => [
                    name,
                    resolvePathIfPresent(base, dataset),
                ]),
            );
        }
    }
    result.webServerSchema = resolvePathIfPresent(base, result.webServerSchema);
    result.input = resolvePathIfPresent(base, result.input);
    result.inputSchema = resolvePathIfPresent(base, result.inputSchema);
    result.output = resolvePathIfPresent(base, result.output);
    result.outputSchema = resolvePathIfPresent(base, result.outputSchema);
    result.dockerfile = resolvePathIfPresent(base, config.dockerfile);
    return result;
}
