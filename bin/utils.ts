import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ActorConfig, ActorConfigFile, ActorConfigFileEntry } from './types.js';

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

export const getRepoActors = async (): Promise<ActorConfig[]> => {
    return readConfigFile();
};

const CONFIG_FILE_NAME = '.test-tools-actors-config.json';

export const readConfigFile = async (): Promise<ActorConfig[]> => {
    let raw: string;
    try {
        raw = await fs.readFile(CONFIG_FILE_NAME, 'utf-8');
    } catch {
        throw new Error(
            `Config file "${CONFIG_FILE_NAME}" not found in the current directory. ` +
                `Run "init-config" to generate one, then fill in the owner and tokenEnvVar fields.`,
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
        const folder = entry.folder === '.' ? '' : entry.folder;

        if (seenFolders.has(folder)) {
            throw new Error(
                `Duplicate folder "${entry.folder}" in "${CONFIG_FILE_NAME}". Each actor must have a unique folder.`,
            );
        }
        seenFolders.add(folder);

        const actorJsonPath = folder ? `${folder}/.actor/actor.json` : '.actor/actor.json';

        if (folder) {
            try {
                await fs.access(folder);
            } catch {
                throw new Error(
                    `Folder "${folder}" declared in "${CONFIG_FILE_NAME}" does not exist on disk.`,
                );
            }
        }

        let actorJson: { name?: string };
        try {
            actorJson = JSON.parse(await fs.readFile(actorJsonPath, 'utf-8'));
        } catch {
            throw new Error(
                `Cannot read "${actorJsonPath}". Every actor entry in "${CONFIG_FILE_NAME}" ` +
                    `must have a corresponding .actor/actor.json file.`,
            );
        }

        if (!actorJson.name) {
            throw new Error(
                `Missing "name" field in "${actorJsonPath}". ` +
                    `Every actor must have a "name" in its .actor/actor.json.`,
            );
        }

        actorConfigs.push({
            actorName: `${entry.owner}/${actorJson.name}`,
            folder,
            isStandalone: entry.isStandalone ?? false,
            tokenEnvVar: entry.tokenEnvVar,
        });
    }

    return actorConfigs;
};

interface GenerateConfigOptions {
    defaultOwner?: string;
    defaultTokenVar?: string;
}

export const generateConfigFile = async (options: GenerateConfigOptions = {}): Promise<void> => {
    try {
        await fs.access(CONFIG_FILE_NAME);
        throw new Error(
            `Config file "${CONFIG_FILE_NAME}" already exists. ` +
                `Remove it first if you want to regenerate.`,
        );
    } catch (err) {
        if (err instanceof Error && err.message.includes('already exists')) throw err;
    }

    const trackedFiles = execSync('git ls-files', { encoding: 'utf-8' }).trim().split('\n');
    const actorJsonFiles = trackedFiles.filter((f) => f.endsWith('.actor/actor.json'));

    if (actorJsonFiles.length === 0) {
        throw new Error('No .actor/actor.json files found in the repository.');
    }

    const hasRoot = actorJsonFiles.includes('.actor/actor.json');
    const subfolderActorJsonFiles = actorJsonFiles.filter((f) => f !== '.actor/actor.json');

    if (hasRoot && subfolderActorJsonFiles.length > 0) {
        console.error(
            `\nNote: Found a root-level .actor/actor.json alongside ${subfolderActorJsonFiles.length} subfolder actor(s).` +
                `\nIf the root .actor/actor.json only exists to satisfy the Apify CLI and is not a real actor,` +
                `\nconsider removing its entry from the generated config file.\n`,
        );
    }

    const entries: ActorConfigFileEntry[] = [];

    for (const actorJsonPath of actorJsonFiles) {
        const folder = actorJsonPath === '.actor/actor.json' ? '' : path.dirname(path.dirname(actorJsonPath));

        entries.push({
            folder: folder || '.',
            owner: options.defaultOwner ?? '<OWNER>',
            tokenEnvVar: options.defaultTokenVar ?? '<TOKEN_ENV_VAR>',
        });
    }

    const config: ActorConfigFile = { actors: entries };
    await fs.writeFile(CONFIG_FILE_NAME, `$${JSON.stringify(config, null, 4)}`);
    console.error(`Created "${CONFIG_FILE_NAME}" with ${entries.length} actor(s). Fill in the owner and tokenEnvVar fields.`);
};

export const setCwd = ({ workspace }: { workspace: string | undefined }) => {
    if (workspace) {
        process.chdir(workspace);
        return;
    }
    const ghWorkspace = getEnvVar('GITHUB_WORKSPACE', process.cwd());
    process.chdir(ghWorkspace);
};
