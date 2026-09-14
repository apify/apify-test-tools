import { dirname, join, normalize } from 'node:path';

import z from 'zod';

import type { ActorConfig } from '../types.js';
import { getActorJson, getActorJsonPath } from './actor-json.js';
import { safeReadJsonObjectFile } from './files.js';

export const CONFIG_FILE_NAME = 'apify-test-tools.config.json';

const ACTOR_CONFIG_SCHEMA = z.object({
    actors: z.array(
        z.object({
            folder: z.string().nonempty(),
            actorFullName: z.string().regex(/^[\w-]+\/[\w-]+$/),
            tokenEnvVar: z.string().nonempty(),
            overrideActorContext: z.array(z.string()).nonempty().optional(),
        }),
    ),
});
export type ActorConfigFile = z.infer<typeof ACTOR_CONFIG_SCHEMA>;

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
        `Duplicate actor full names on the following actors in "${CONFIG_FILE_NAME}": \n${duplicates.map(([name]) => name).join('\n')}`,
    );
}
function filterBySelection(
    selection: { actors: string[]; ignore: string[] },
    actorConfigs: ActorConfig[],
): ActorConfig[] {
    const actorsToIgnore = new Set(selection.ignore);
    return actorConfigs.filter((actorConfig) => {
        if (actorsToIgnore.has(actorConfig.actorFullName)) {
            return false;
        }
        return selection.actors.includes(actorConfig.actorFullName);
    });
}

export const readConfigFile = async (selection: { actors: string[]; ignore: string[] }): Promise<ActorConfig[]> => {
    const file = await safeReadJsonObjectFile(CONFIG_FILE_NAME);
    if (!file.success) {
        throw file.failure;
    }
    const parsed = ACTOR_CONFIG_SCHEMA.safeParse(file.contents);
    if (!parsed.success) {
        console.error(`Config file is not valid. See errors below\n${z.prettifyError(parsed.error)}`);
        throw new Error(`Config file is not valid`);
    }

    const results: ActorConfig[] = [];
    for (const actorConfig of parsed.data.actors) {
        const path = getActorJsonPath(actorConfig.folder);
        const actorJson = await getActorJson(path);
        const resolvedDockerContextDir = normalize(join(dirname(path), actorJson.dockerContextDir));

        const contextPaths = actorConfig.overrideActorContext?.map((p) => normalize(p)) ?? [resolvedDockerContextDir];
        results.push({
            ...actorConfig,
            actorConfig: actorJson,
            contextPaths,
            dockerContextDir: resolvedDockerContextDir,
        });
    }
    enforceUniqueActorFullNames(results);
    const selectedActors = filterBySelection(selection, results);
    return selectedActors;
};

// export const readConfigFile = async (selection: { actors: string[]; ignore: string[] }): Promise<ActorConfig[]> => {
//     const file = await safeReadJsonObjectFile(CONFIG_FILE_NAME);
//     if (!file.success) {
//         throw file.failure;
//     }
//     let raw: string;
//     try {
//         raw = await fs.readFile(CONFIG_FILE_NAME, 'utf-8');
//     } catch {
//         throw new Error(
//             `Config file "${CONFIG_FILE_NAME}" not found in the current directory. ` +
//                 `Please create one with the required actor entries.`,
//         );
//     }

//     let config: ActorConfigFile;
//     try {
//         config = JSON.parse(raw);
//     } catch {
//         throw new Error(`Config file "${CONFIG_FILE_NAME}" contains invalid JSON.`);
//     }

//     if (!Array.isArray(config.actors)) {
//         throw new Error(`Config file "${CONFIG_FILE_NAME}" must have an "actors" array at the top level.`);
//     }

//     const seenFolders = new Set<string>();
//     const actorConfigs: ActorConfig[] = [];

//     for (const [index, entry] of config.actors.entries()) {
//         if (typeof entry.folder !== 'string') {
//             throw new Error(
//                 `Invalid "folder" for actor entry at index ${index} in "${CONFIG_FILE_NAME}". ` +
//                     `Must be a string (use "." for a single-actor repo).`,
//             );
//         }

//         const folder = entry.folder === '.' ? '' : stripTrailingSlash(entry.folder);

//         if (seenFolders.has(folder)) {
//             throw new Error(
//                 `Duplicate folder "${entry.folder}" in "${CONFIG_FILE_NAME}". Each actor must have a unique folder.`,
//             );
//         }
//         seenFolders.add(folder);

//         const nameParts = entry.actorFullName?.split('/');
//         if (!nameParts || nameParts.length !== 2 || !nameParts[0] || !nameParts[1]) {
//             throw new Error(
//                 `Invalid "actorFullName" for folder "${entry.folder}" in "${CONFIG_FILE_NAME}". ` +
//                     `Must be in "owner/name" format (e.g. "apify/web-scraper").`,
//             );
//         }

//         if (entry.overrideActorContext !== undefined) {
//             if (
//                 !Array.isArray(entry.overrideActorContext) ||
//                 !entry.overrideActorContext.every((p) => typeof p === 'string')
//             ) {
//                 throw new Error(
//                     `Invalid "overrideActorContext" for folder "${entry.folder}" in "${CONFIG_FILE_NAME}". ` +
//                         `Must be an array of strings.`,
//                 );
//             }
//         }

//         const actorJsonPath = folder ? `${folder}/.actor/actor.json` : '.actor/actor.json';

//         let actorJson: { dockerContextDir?: string };
//         try {
//             actorJson = JSON.parse(await fs.readFile(actorJsonPath, 'utf-8'));
//         } catch {
//             throw new Error(
//                 `Cannot read "${actorJsonPath}". Every actor entry in "${CONFIG_FILE_NAME}" ` +
//                     `must have a corresponding .actor/actor.json file.`,
//             );
//         }

//         const actorDotDir = folder ? `${folder}/.actor` : '.actor';
//         const rawDockerContextDir = actorJson.dockerContextDir ?? '..';
//         const resolved = path.resolve(process.cwd(), actorDotDir, rawDockerContextDir);
//         const dockerContextDir = path.relative(process.cwd(), resolved);

//         if (dockerContextDir.startsWith('..')) {
//             throw new Error(
//                 `"dockerContextDir" for folder "${entry.folder}" resolves outside the repository root. ` +
//                     `Resolved path: "${dockerContextDir}".`,
//             );
//         }

//         const normalizedDockerContextDir = dockerContextDir === '.' ? '' : dockerContextDir;
//         const contextPaths = (entry.overrideActorContext ?? [normalizedDockerContextDir]).map(stripTrailingSlash);

//         // The actor's own folder is always part of its context. When an explicit "overrideActorContext"
//         // doesn't already cover it, add it automatically instead of failing the workflow.
//         if (!contextPaths.some((contextPath) => isPathWithinScope(folder, contextPath))) {
//             contextPaths.push(folder);
//         }

//         const overlap = findOverlappingContextPaths(contextPaths);
//         if (overlap) {
//             throw new Error(
//                 `Invalid context paths for folder "${entry.folder}" in "${CONFIG_FILE_NAME}": ` +
//                     `"${overlap[0]}" and "${overlap[1]}" overlap. Context paths must not be prefixes of one another.`,
//             );
//         }

//         actorConfigs.push({
//             actorFullName: entry.actorFullName,
//             folder,
//             tokenEnvVar: entry.tokenEnvVar,
//             dockerContextDir: normalizedDockerContextDir,
//             contextPaths,
//         });
//     }

//     return selectActors(selection, actorConfigs);
// };
