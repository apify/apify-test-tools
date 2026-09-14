import { join, normalize } from 'node:path';

import z from 'zod';

import { ACTOR_LIMITS } from '@apify/consts';

import { safeReadJsonObjectFile } from './files.js';

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
console.log(normalize('../apify-test-tools/bin/utils/.././../bin/.'));

/**
 * @param actorDir path to actor.json
 * @throws Error when file does not exist
 * @throws Error when file is not a file
 * @throws Error when file is not valid JSON
 * @throws Error when file is not valid actor.json
 */
export async function getActorJson(path: string): Promise<ActorJson> {
    const file = await safeReadJsonObjectFile(path);
    if (!file.success) {
        throw file.failure;
    }
    const parsed = ACTOR_JSON_SCHEMA.safeParse(file.contents);
    if (!parsed.success) {
        console.error(`Actor.json is not valid. See errors below\n${z.prettifyError(parsed.error)}`);
        throw new Error(`actor.json at ${path} is not valid`);
    }
    return parsed.data;
}
