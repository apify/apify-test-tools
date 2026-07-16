import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ActorVersionSourceFile } from 'apify-client';

import { SOURCE_FILE_FORMATS } from '@apify/consts';

import type { ActorConfig } from './types.js';

// Returns true when `childPath` is not inside `parentPath`.
// Used to detect monorepo actors whose dockerContextDir escapes the actor directory.
export const isOutsideDir = (childPath: string, parentPath: string): boolean =>
    path.relative(parentPath, childPath).startsWith('..');

/**
 * Lists every file under `subDir` (paths relative to `repoRoot`) that's either tracked by git or
 * present but untracked in the working tree — deliberately omitting `--exclude-standard`, so
 * gitignored files are included too. Callers combine this with getGitignoredPaths to decide what
 * to keep, e.g. because .actor/ must survive even if .gitignore would otherwise exclude it.
 * This also means .git/ itself is never walked, since git never lists its own internals here.
 */
export const listRepoFilePaths = (repoRoot: string, subDir: string): string[] => {
    const relSubDir = path.relative(repoRoot, subDir).split(path.sep).join('/') || '.';
    const result = spawnSync('git', ['ls-files', '--cached', '--others', '-z', '--', relSubDir], {
        cwd: repoRoot,
        maxBuffer: 100 * 1024 * 1024,
    });

    if (result.status !== 0) {
        throw new Error(`[Command failed]: git ls-files\n${result.stderr.toString()}`);
    }

    return result.stdout.toString().split('\0').filter(Boolean);
};

/**
 * Given paths relative to the repo root, returns the subset that `git` would exclude because of
 * .gitignore rules (including nested .gitignore files, `.git/info/exclude`, and global excludes —
 * anything `git` itself respects). Delegating to `git check-ignore` avoids re-implementing gitignore
 * pattern matching.
 */
export const getGitignoredPaths = (relativePaths: string[]): Set<string> => {
    if (relativePaths.length === 0) return new Set();

    const result = spawnSync('git', ['check-ignore', '--stdin'], {
        input: relativePaths.join('\n'),
        maxBuffer: 100 * 1024 * 1024,
    });

    // Exit code 1 means none of the given paths are ignored - not an error. Anything else
    // (e.g. 128 for "not a git repository") is a real failure.
    if (result.status !== 0 && result.status !== 1) {
        throw new Error(`[Command failed]: git check-ignore\n${result.stderr.toString()}`);
    }

    return new Set(result.stdout.toString().split('\n').filter(Boolean));
};

// Docker normalizes each pattern before matching, so a leading "./" (as in the common "./node_modules"
// style) is a no-op for Docker. git's ignore engine has no such normalization — it treats "./" as
// literal pattern text that can never match a real path, so a .dockerignore written in that style
// would otherwise silently match nothing under git. Strip it here (after any negation prefix) so
// git sees the same effective pattern Docker would.
const normalizeDockerignorePattern = (line: string): string => line.replace(/^(!?)(?:\.\/)+/, '$1');

/**
 * Given paths relative to `rootDir`, returns the subset that a `.dockerignore` file sitting at
 * `rootDir` would exclude — mirroring getGitignoredPaths, but for Docker's own ignore file. `git
 * check-ignore` has no built-in notion of .dockerignore, but pointing `core.excludesFile` at a
 * normalized copy of it for a single invocation makes git apply its patterns exactly like a
 * .gitignore, without re-implementing gitignore-style pattern matching ourselves. A missing
 * .dockerignore is a no-op (empty set), so there's no need to check for its existence first.
 *
 * Crucially this passes `--no-index`: by default git never reports an already-tracked file as
 * ignored (that's how real .gitignore semantics work — tracked files aren't affected by ignore
 * rules), but Docker excludes a matching path from the build context unconditionally, regardless
 * of git tracking. `--no-index` makes git apply the patterns uniformly, matching Docker's behavior.
 */
export const getDockerignoredPaths = (rootDir: string, relativePaths: string[]): Set<string> => {
    if (relativePaths.length === 0) return new Set();

    let dockerignoreContent: string;
    try {
        dockerignoreContent = fsSync.readFileSync(path.join(rootDir, '.dockerignore'), 'utf8');
    } catch {
        return new Set();
    }

    const normalizedContent = dockerignoreContent.split('\n').map(normalizeDockerignorePattern).join('\n');

    const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'apify-dockerignore-'));
    try {
        const normalizedPath = path.join(tempDir, '.dockerignore');
        fsSync.writeFileSync(normalizedPath, normalizedContent);

        const result = spawnSync(
            'git',
            ['-c', `core.excludesFile=${normalizedPath}`, 'check-ignore', '--no-index', '--stdin'],
            {
                cwd: rootDir,
                input: relativePaths.join('\n'),
                maxBuffer: 100 * 1024 * 1024,
            },
        );

        // Exit code 1 means none of the given paths are ignored - not an error. Anything else
        // (e.g. 128 for "not a git repository") is a real failure.
        if (result.status !== 0 && result.status !== 1) {
            throw new Error(`[Command failed]: git check-ignore (dockerignore)\n${result.stderr.toString()}`);
        }

        return new Set(result.stdout.toString().split('\n').filter(Boolean));
    } finally {
        fsSync.rmSync(tempDir, { recursive: true, force: true });
    }
};

const isBinary = (buffer: Buffer): boolean => buffer.includes(0);

export const toActorVersionSourceFile = async (absPath: string, rootDir: string): Promise<ActorVersionSourceFile> => {
    const buffer = await fs.readFile(absPath);
    const name = path.relative(rootDir, absPath).split(path.sep).join('/');
    return isBinary(buffer)
        ? { name, format: SOURCE_FILE_FORMATS.BASE64, content: buffer.toString('base64') }
        : { name, format: SOURCE_FILE_FORMATS.TEXT, content: buffer.toString('utf8') };
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
