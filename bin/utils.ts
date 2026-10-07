import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

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
export const listRepoFilePaths = async (repoRoot: string, subDir: string): Promise<string[]> => {
    const relSubDir = path.relative(repoRoot, subDir).split(path.sep).join('/') || '.';
    const output = await runGitCommand(['ls-files', '--cached', '--others', '-z', '--', relSubDir], repoRoot);
    return output.split('\0').filter(Boolean);
};

/**
 * Given paths relative to the repo root, returns the subset that `git` would exclude because of
 * .gitignore rules (including nested .gitignore files, `.git/info/exclude`, and global excludes —
 * anything `git` itself respects). Delegating to `git check-ignore` avoids re-implementing gitignore
 * pattern matching.
 */
export const getGitignoredPaths = async (relativePaths: string[], cwd?: string): Promise<Set<string>> => {
    if (relativePaths.length === 0) return new Set();

    // Exit code 1 means none of the given paths are ignored - not an error. Anything else
    // (e.g. 128 for "not a git repository") is a real failure.
    return runGitCommand(['check-ignore', '--', ...relativePaths], cwd)
        .then((output) => new Set(output.split('\n').filter(Boolean)))
        .catch((error: unknown) => {
            // no files are ignored
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
                return new Set<string>();
            }
            throw error;
        });
};

export type SourceFile = { name: string; content: Buffer };

export const readSourceFile = async (absPath: string, rootDir: string): Promise<SourceFile> => ({
    name: path.relative(rootDir, absPath).split(path.sep).join('/'),
    content: await fs.readFile(absPath),
});

export const spawnCommand = (command: string, args: string[] = []) => {
    logger.info(command, args.join(' '));
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

/** Runs Git asynchronously, passing each argument directly to Git without a shell. */
export const runGitCommand = async (args: string[], cwd?: string): Promise<string> => {
    logger.debug('git', args);
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
    return stdout.trim();
};

export const getEnvVar = (varName: string, defaultValue?: string): string => {
    const value = process.env[varName] ?? defaultValue;
    if (!value) {
        throw new Error(`${varName} not defined`);
    }
    return value;
};
