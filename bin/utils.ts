import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import type {
    ActorConfig,
    Commit,
    GitHubEvent,
} from './types.js';

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

export const getRepoName = (githubEvent: GitHubEvent) => {
    const [, repoName] = githubEvent.repository.full_name.split('/');
    return repoName;
};

export const getEnvVar = (varName: string, defaultValue?: string): string => {
    const value = process.env[varName] ?? defaultValue;
    if (!value) {
        throw new Error(`${varName} not defined`);
    }
    return value;
};

export const getRunUrlKvsKey = (runnerName: string) => {
    return `RUN_URL-${runnerName}`;
};

/**
 * Reads and parses all directories in `actors` directory
 * This works locally if checkoutRepoLocally is called first
 */
export const getRepoActors = async (): Promise<ActorConfig[]> => {
    let actorDirs: string[];
    try {
        actorDirs = (await fs.readdir(`./actors`)).map((dir) => `actors/${dir}`);
    } catch (err) {
        console.warn(`No /actors directory found in repo`);
        actorDirs = [];
    }
    let standaloneActorDirs: string[];
    try {
        standaloneActorDirs = (await fs.readdir(`./standalone-actors`)).map((dir) => `standalone-actors/${dir}`);
    } catch (err) {
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
    console.error(`Actors in repo: ${actorConfigs.filter(({ isStandalone }) => !isStandalone).map(({ actorName }) => actorName).join(', ')}`);
    console.error(`Standalone actors in repo: ${actorConfigs.filter(({ isStandalone }) => !!isStandalone).map(({ actorName }) => actorName).join(', ')}`);
    return actorConfigs;
};

export const setCwd = ({ workspace }: { workspace: string | undefined }) => {
    if (workspace) {
        process.chdir(workspace);
        return;
    }
    const ghWorkspace = getEnvVar('GITHUB_WORKSPACE', process.cwd());
    process.chdir(ghWorkspace);
}

export const getHeadCommitSha = (githubEvent: GitHubEvent) => {
    return githubEvent.type === 'pull_request'
        ? githubEvent.pull_request.head.sha
        : githubEvent.head_commit.id;
};

export interface GetChangedActorsResult {
    actorsChanged: ActorConfig[];
    codeChanged: boolean;
}

interface ShouldBuildAndTestOptions {
    filepathsChanged: string[];
    actorConfigs: ActorConfig[];
    // Just for logging
    isLatest?: boolean;
}

/**
 * Also works for folders
 */
const isIgnoredTopLevelFile = (lowercaseFilePath: string) => {
    // On top level, we should only have dev-only readme and .actor/ is just for apify push CLI (real Actor configs are in /actors)
    const IGNORED_TOP_LEVEL_FILES = ['.vscode/', '.gitignore', 'readme.md', '.husky/', '.eslintrc', '.editorconfig', '.actor/'];
    // Strip out deprecated /code and /shared folders, treat them as top-level code
    const sanitizedLowercaseFilePath = lowercaseFilePath.replace(/^code\//, '').replace(/^shared\//, '');

    return IGNORED_TOP_LEVEL_FILES.some((ignoredFile) => sanitizedLowercaseFilePath.startsWith(ignoredFile));
};

const isLatestBuildOnlyFile = (lowercaseFilePath: string) => {
    if (lowercaseFilePath.endsWith('changelog.md')) {
        return true;
    }

    // Either in /actors or /standalone-actors, we need to rebuild readme but we don't rebuild top-level dev-only readme
    if ((lowercaseFilePath.startsWith('actors/') || lowercaseFilePath.startsWith('standalone-actors/')) && lowercaseFilePath.endsWith('readme.md')) {
        return true;
    }

    return false;
};

/**
 * Latest and devel are the same except that for latest we also rebuild with README and CHANGELOG files
 */
export const getChangedActors = (
    { filepathsChanged, actorConfigs, isLatest = false }: ShouldBuildAndTestOptions,
): GetChangedActorsResult => {
    let codeChanged = false;
    // folder -> ActorConfig
    const actorsChangedMap = new Map<string, ActorConfig>();

    const actorConfigsWithoutStandalone = actorConfigs.filter(({ isStandalone }) => !isStandalone);

    const lowercaseFiles = filepathsChanged.map((file) => file.toLowerCase());

    for (const lowercaseFilePath of lowercaseFiles) {
        if (isIgnoredTopLevelFile(lowercaseFilePath)) {
            continue;
        }
        // First we check for specific actors that have configs in /actors or standalone actors in /standalone-actors
        // This matches both actors/username_actorName and standalone-actors/username_actorName
        const changedActorConfigMatch = lowercaseFilePath.match(/^(?:standalone-)?actors\/([^/]+)\/.+/);
        if (changedActorConfigMatch) {
            const sanitizedActorName = changedActorConfigMatch[1].replace('_', '/');
            const actorConfigChanged = actorConfigs.find(({ actorName }) => actorName.toLowerCase() === sanitizedActorName);
            if (actorConfigChanged === undefined) {
                console.warn('changes was found in an actor folder which no longer exists in the current commit', {
                    actorName: sanitizedActorName,
                    actorFolderName: changedActorConfigMatch[1],
                });
                continue;
            }

            console.error(`actorConfigChanged ${actorConfigChanged.actorName}: sanitizedActorName ${sanitizedActorName} ${lowercaseFilePath} `);
            // These can be nested at various folders inside the actor folder
            if (isLatest || !isLatestBuildOnlyFile(lowercaseFilePath)) {
                // We assume other files will are either actor.json or input_schema.json and those needs to be tested
                // TODO: Check what changed in schema, we don't need to test description changes
                actorsChangedMap.set(actorConfigChanged.folder, actorConfigChanged);
            }
            continue;
        }

        // We check top level files (formerly in /code and /shared folders) that are shared among all non-standalone Actors
        // Standalone actors are always handled separately by name via changedActorConfigMatch
        if (isLatest || !isLatestBuildOnlyFile(lowercaseFilePath)) {
            codeChanged = !isLatest; // NOTE: code is changed only in PR
            for (const actorConfig of actorConfigsWithoutStandalone) {
                actorsChangedMap.set(actorConfig.folder, actorConfig);
            }
        }
    }

    const actorsChanged = Array.from(actorsChangedMap.values());

    // All below here is just for logging
    const ignoredFilesChanged = lowercaseFiles.filter((file) => isIgnoredTopLevelFile(file));
    console.error(`[DIFF]: Top level files changed that we ignore (don't trigger test or build): ${ignoredFilesChanged.join(', ')}`);

    const onlyLatestFilesChanged = lowercaseFiles.filter((file) => isLatestBuildOnlyFile(file));
    console.error(`[DIFF]: Files changed that only trigger latest build: ${onlyLatestFilesChanged.join(', ')}`);

    if (!isLatest && codeChanged) {
        console.error(`[DIFF]: All non-standalone Actors need to be built and tested (changes in top-level code)`);
    }

    if (actorsChanged.length > 0) {
        const miniactors = actorsChanged.filter((config) => !config.isStandalone).map((config) => config.actorName);
        const standaloneActors = actorsChanged.filter((config) => config.isStandalone).map((config) => config.actorName);
        console.error(`[DIFF]: MiniActors to be built and tested: ${miniactors.join(', ')}`);
        console.error(`[DIFF]: Standalone Actors to be built and tested: ${standaloneActors.join(', ')}`);
    } else {
        console.error(`[DIFF]: No relevant files changed, skipping builds and tests`);
    }

    return {
        actorsChanged,
        codeChanged,
    };
};
