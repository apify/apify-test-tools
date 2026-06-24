import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';

import { ApifyClient } from 'apify-client';

import type { ActorConfig } from './types.js';

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

let cachedBuilderUsername: string | undefined;

export const resolveBuilderTokenUsername = async (): Promise<string> => {
    if (cachedBuilderUsername) return cachedBuilderUsername;
    const token = process.env.BUILDER_APIFY_TOKEN;
    if (!token) {
        throw new Error(
            'BUILDER_APIFY_TOKEN is not set. Either use the "owner_actor-name" folder convention ' +
                'or set the BUILDER_APIFY_TOKEN secret.',
        );
    }
    const client = new ApifyClient({ token });
    const user = await client.user().get();
    cachedBuilderUsername = user.username!;
    return cachedBuilderUsername;
};

const readActorName = async (actorJsonPath: string): Promise<string> => {
    const actorJson: { name?: string } = JSON.parse(await fs.readFile(actorJsonPath, 'utf-8'));
    if (!actorJson.name) {
        throw new Error(
            `Missing "name" field in "${actorJsonPath}". ` +
                `Every actor folder must have .actor/actor.json with a "name" field.`,
        );
    }
    return actorJson.name;
};

const resolveOwner = async (folderName: string): Promise<string> => {
    const ownerMatch = folderName.match(/^(.+)_[^_]+$/);
    if (ownerMatch) return ownerMatch[1];
    return resolveBuilderTokenUsername();
};

/**
 * Reads and parses all directories in `actors` directory
 * This works locally if checkoutRepoLocally is called first
 */
export const getRepoActors = async (): Promise<ActorConfig[]> => {
    let actorDirs: string[];
    try {
        actorDirs = (await fs.readdir(`./actors`)).map((dir) => `actors/${dir}`);
    } catch {
        console.warn(`No /actors directory found in repo`);
        actorDirs = [];
    }
    let standaloneActorDirs: string[];
    try {
        standaloneActorDirs = (await fs.readdir(`./standalone-actors`)).map((dir) => `standalone-actors/${dir}`);
    } catch {
        console.warn(`No /standalone-actors directory found in repo`);
        standaloneActorDirs = [];
    }
    if (actorDirs.length === 0 && standaloneActorDirs.length === 0) {
        let actorName: string;
        try {
            actorName = await readActorName('./.actor/actor.json');
        } catch {
            return [];
        }
        const owner = await resolveBuilderTokenUsername();
        console.error(`Root .actor/ mode: single actor ${owner}/${actorName}`);
        return [{ actorName: `${owner}/${actorName}`, folder: '', isStandalone: false }];
    }

    const actorConfigs: ActorConfig[] = [];
    for (const actorDir of [...actorDirs, ...standaloneActorDirs]) {
        let actorName: string;
        try {
            actorName = await readActorName(`./${actorDir}/.actor/actor.json`);
        } catch {
            throw new Error(
                `Missing or unreadable .actor/actor.json in "${actorDir}". ` +
                    `Every actor folder must contain .actor/actor.json with a "name" field.`,
            );
        }

        const folderName = actorDir.split('/')[1];
        const folderType = actorDir.split('/')[0];
        const owner = await resolveOwner(folderName);

        actorConfigs.push({
            actorName: `${owner}/${actorName}`,
            folder: actorDir,
            isStandalone: folderType === 'standalone-actors',
        });
    }
    console.error(
        `Actors in repo: ${actorConfigs
            .filter(({ isStandalone }) => !isStandalone)
            .map(({ actorName }) => actorName)
            .join(', ')}`,
    );
    console.error(
        `Standalone actors in repo: ${actorConfigs
            .filter(({ isStandalone }) => !!isStandalone)
            .map(({ actorName }) => actorName)
            .join(', ')}`,
    );
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
