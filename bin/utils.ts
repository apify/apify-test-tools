import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ActorVersionSourceFile } from 'apify-client';

import type { ActorConfig } from './types.js';

// Returns true when `childPath` is not inside `parentPath`.
// Used to detect monorepo actors whose dockerContextDir escapes the actor directory.
export const isOutsideDir = (childPath: string, parentPath: string): boolean =>
    path.relative(parentPath, childPath).startsWith('..');

export const collectFilePaths = async (
    rootDir: string,
    skipDirs: Set<string>,
    isSecretFile: (fileName: string) => boolean,
): Promise<string[]> => {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const filePaths: string[] = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (skipDirs.has(entry.name)) continue;
            filePaths.push(...(await collectFilePaths(path.join(rootDir, entry.name), skipDirs, isSecretFile)));
        } else if (entry.isFile()) {
            if (isSecretFile(entry.name)) continue;
            filePaths.push(path.join(rootDir, entry.name));
        }
    }
    return filePaths;
};

const isBinary = (buffer: Buffer): boolean => buffer.includes(0);

export const toSourceFile = async (absPath: string, rootDir: string): Promise<ActorVersionSourceFile> => {
    const buffer = await fs.readFile(absPath);
    const name = path.relative(rootDir, absPath).split(path.sep).join('/');
    return isBinary(buffer)
        ? { name, format: 'BASE64', content: buffer.toString('base64') }
        : { name, format: 'TEXT', content: buffer.toString('utf8') };
};

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
    const actorConfigs: ActorConfig[] = [];
    for (const actorDir of [...actorDirs, ...standaloneActorDirs]) {
        const match = actorDir.match(/^([^/]+)\/(.+)_([^_]+)$/);
        if (!match) {
            throw new Error(`Invalid actor directory name. Got "${actorDir}", expected "actor.owner-name_actor-name"`);
        }
        const [, folderType, owner, actorName] = match;
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
