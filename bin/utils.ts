import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isPathWithinScope } from './path-utils.js';
import type { ActorConfig, ActorConfigFile } from './types.js';

export const spawnCommandInGhWorkspace = (command: string, args: string[] = []) => {
    console.error(command, args.join(' '));
    const commandResult = spawnSync(command, args, { shell: true, maxBuffer: 100 * 1024 * 1024 });

    if (commandResult.error) {
        throw new Error(`[Command failed]: ${command}\n${commandResult.error}`);
    }

    if (commandResult.stderr.toString().length > 0) {
        // For some reason 'git' command prints stderr when checking out to detached HEAD state (we only use detached HEAD for testing though)
        if (!commandResult.stderr.toString().includes(`You are in 'detached HEAD' state`)) {
            throw new Error(`[Command printed stderr]: ${command}\n${commandResult.stderr.toString()}`);
        }
    }

    return commandResult.stdout.toString().trim();
};

export const getEnvVar = (varName: string, defaultValue?: string): string => {
    const value = process.env[varName] ?? defaultValue;
    if (!value) {
        throw new Error(`${varName} not defined`);
    }
    return value;
};

const CONFIG_FILE_NAME = '.test-tools-actors-config.json';

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

export const readConfigFile = async (): Promise<ActorConfig[]> => {
    let raw: string;
    try {
        raw = await fs.readFile(CONFIG_FILE_NAME, 'utf-8');
    } catch {
        throw new Error(
            `Config file "${CONFIG_FILE_NAME}" not found in the current directory. ` +
                `Please create one with the required actor entries.`,
        );
    }

    let config: ActorConfigFile;
    try {
        config = JSON.parse(raw);
    } catch {
        throw new Error(`Config file "${CONFIG_FILE_NAME}" contains invalid JSON.`);
    }

    if (!Array.isArray(config.actors)) {
        throw new Error(`Config file "${CONFIG_FILE_NAME}" must have an "actors" array at the top level.`);
    }

    const seenFolders = new Set<string>();
    const actorConfigs: ActorConfig[] = [];

    for (const entry of config.actors) {
        const folder = entry.folder === '.' ? '' : stripTrailingSlash(entry.folder);

        if (seenFolders.has(folder)) {
            throw new Error(
                `Duplicate folder "${entry.folder}" in "${CONFIG_FILE_NAME}". Each actor must have a unique folder.`,
            );
        }
        seenFolders.add(folder);

        const nameParts = entry.actorName?.split('/');
        if (!nameParts || nameParts.length !== 2 || !nameParts[0] || !nameParts[1]) {
            throw new Error(
                `Invalid "actorName" for folder "${entry.folder}" in "${CONFIG_FILE_NAME}". ` +
                    `Must be in "owner/name" format (e.g. "apify/web-scraper").`,
            );
        }

        if (entry.overrideActorContext !== undefined) {
            if (
                !Array.isArray(entry.overrideActorContext) ||
                !entry.overrideActorContext.every((p) => typeof p === 'string')
            ) {
                throw new Error(
                    `Invalid "overrideActorContext" for folder "${entry.folder}" in "${CONFIG_FILE_NAME}". ` +
                        `Must be an array of strings.`,
                );
            }
        }

        const actorJsonPath = folder ? `${folder}/.actor/actor.json` : '.actor/actor.json';

        let actorJson: { dockerContextDir?: string };
        try {
            actorJson = JSON.parse(await fs.readFile(actorJsonPath, 'utf-8'));
        } catch {
            throw new Error(
                `Cannot read "${actorJsonPath}". Every actor entry in "${CONFIG_FILE_NAME}" ` +
                    `must have a corresponding .actor/actor.json file.`,
            );
        }

        const actorDotDir = folder ? `${folder}/.actor` : '.actor';
        const rawDockerContextDir = actorJson.dockerContextDir ?? '..';
        const resolved = path.resolve(process.cwd(), actorDotDir, rawDockerContextDir);
        const dockerContextDir = path.relative(process.cwd(), resolved);

        if (dockerContextDir.startsWith('..')) {
            throw new Error(
                `"dockerContextDir" for folder "${entry.folder}" resolves outside the repository root. ` +
                    `Resolved path: "${dockerContextDir}".`,
            );
        }

        const normalizedDockerContextDir = dockerContextDir === '.' ? '' : dockerContextDir;
        const contextPaths = (entry.overrideActorContext ?? [normalizedDockerContextDir]).map(stripTrailingSlash);

        const overlap = findOverlappingContextPaths(contextPaths);
        if (overlap) {
            throw new Error(
                `Invalid context paths for folder "${entry.folder}" in "${CONFIG_FILE_NAME}": ` +
                    `"${overlap[0]}" and "${overlap[1]}" overlap. Context paths must not be prefixes of one another.`,
            );
        }

        if (!contextPaths.some((contextPath) => isPathWithinScope(folder, contextPath))) {
            throw new Error(
                `Actor folder "${entry.folder}" in "${CONFIG_FILE_NAME}" is not reachable through its own ` +
                    `context paths (${contextPaths.join(', ')}). Add the actor's own folder to ` +
                    `"overrideActorContext" or remove the override.`,
            );
        }

        actorConfigs.push({
            actorName: entry.actorName,
            folder,
            tokenEnvVar: entry.tokenEnvVar,
            dockerContextDir: normalizedDockerContextDir,
            contextPaths,
        });
    }

    return actorConfigs;
};

export const setCwd = ({ workspace }: { workspace: string | undefined }) => {
    if (workspace) {
        process.chdir(workspace);
        return;
    }
    const ghWorkspace = getEnvVar('GITHUB_WORKSPACE', process.cwd());
    process.chdir(ghWorkspace);
};
