import { readdirSync } from 'node:fs';
import path from 'node:path';

import z from 'zod';

import { safeReadJsonObjectFile } from '../json-file.js';
import { ExistingFile, type RelativeDir, type RelativeFile } from '../path/repo-relative.js';
import type { ValidatedActorConfig } from './structures/base.js';

const inlineOrPath = z.union([z.string(), z.record(z.string(), z.unknown())]).nullish();

const ActorJsonFieldsSchema = z.object({
    dockerContextDir: z.string().default('..'),
    dockerfile: z.string().optional(),
    readme: z.string().nullish(),
    changelog: z.string().nullish(),
    input: inlineOrPath,
    inputSchema: inlineOrPath,
    output: inlineOrPath,
    outputSchema: inlineOrPath,
    webServerSchema: inlineOrPath,
});

export interface ActorJsonPaths {
    file: ExistingFile;
    dockerContextDir: RelativeDir;
    dockerfile?: RelativeFile;
    readme?: RelativeFile;
    changelog?: RelativeFile;
    inputSchema?: RelativeFile;
    outputSchema?: RelativeFile;
    webServerSchema?: RelativeFile;
}

const resolveFile = (actorJsonFile: ExistingFile, field: string, value: unknown): RelativeFile | undefined => {
    if (typeof value !== 'string') return undefined;
    try {
        return actorJsonFile.joinFile(value);
    } catch (error) {
        throw new Error(`Invalid "${field}" in "${actorJsonFile}": ${(error as Error).message}`);
    }
};

const resolveDefaultFileLocations = (
    actorJsonFile: ExistingFile,
    defaults: readonly string[],
): RelativeFile | undefined => {
    for (const candidate of defaults) {
        const file = actorJsonFile.joinFile(candidate);
        const expectedName = path.posix.basename(file.path);
        const entries = readdirSync(file.parent.path);
        const actualName =
            entries.find((entry) => entry === expectedName) ??
            entries.find((entry) => entry.toLowerCase() === expectedName.toLowerCase());
        if (actualName) {
            const actualFile = file.parent.joinFile(actualName);
            if (actualFile.exists()) return actualFile;
        }
    }
    return undefined;
};

export function readActorJson(config: ValidatedActorConfig): ActorJsonPaths {
    const actorJsonPath = config.folder.joinFile('.actor/actor.json');
    let actorJsonFile: ExistingFile;
    try {
        actorJsonFile = ExistingFile.initialize(actorJsonPath);
    } catch {
        throw new Error(
            `Cannot read "${actorJsonPath}". Every actor entry must have a corresponding .actor/actor.json file.`,
        );
    }

    const json = safeReadJsonObjectFile(actorJsonFile);
    if (!json.success) throw new Error(`Cannot read "${actorJsonFile}". ${json.failure.message}`);

    const parsed = ActorJsonFieldsSchema.safeParse(json.contents);
    if (!parsed.success) throw new Error(`Invalid "${actorJsonFile}": ${z.prettifyError(parsed.error)}`);

    const fields = parsed.data;
    let dockerContextDir: RelativeDir;
    try {
        dockerContextDir = actorJsonFile.joinDir(fields.dockerContextDir);
    } catch (error) {
        throw new Error(`Invalid "dockerContextDir" in "${actorJsonFile}": ${(error as Error).message}`);
    }

    return {
        file: actorJsonFile,
        dockerContextDir,
        dockerfile:
            resolveFile(actorJsonFile, 'dockerfile', fields.dockerfile) ??
            resolveDefaultFileLocations(actorJsonFile, ['./Dockerfile', '../Dockerfile']),
        readme:
            resolveFile(actorJsonFile, 'readme', fields.readme) ??
            resolveDefaultFileLocations(actorJsonFile, ['./README.md', '../README.md']),
        changelog:
            resolveFile(actorJsonFile, 'changelog', fields.changelog) ??
            resolveDefaultFileLocations(actorJsonFile, ['./CHANGELOG.md', '../CHANGELOG.md']),
        inputSchema: resolveFile(
            actorJsonFile,
            fields.input != null ? 'input' : 'inputSchema',
            fields.input ?? fields.inputSchema,
        ),
        outputSchema: resolveFile(
            actorJsonFile,
            fields.output != null ? 'output' : 'outputSchema',
            fields.output ?? fields.outputSchema,
        ),
        webServerSchema: resolveFile(actorJsonFile, 'webServerSchema', fields.webServerSchema),
    };
}
