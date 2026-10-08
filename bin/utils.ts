import { execFile } from 'node:child_process';
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
            // exit code 1 means none of the given paths are ignored - not an error
            if (error instanceof GitCommandError && error.exitCode === 1) {
                return new Set<string>();
            }
            if (error instanceof GitCommandError) error.addOperationContext('check which repository paths are ignored');
            throw error;
        });
};

export type SourceFile = { name: string; content: Buffer };

export const readSourceFile = async (absPath: string, rootDir: string): Promise<SourceFile> => ({
    name: path.relative(rootDir, absPath).split(path.sep).join('/'),
    content: await fs.readFile(absPath),
});

export class GitCommandError extends Error {
    readonly args: readonly string[];
    readonly gitError: string;
    readonly exitCode?: number;
    readonly cause: unknown;

    constructor(args: readonly string[], error: unknown) {
        const stderr =
            typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string'
                ? error.stderr.trim()
                : '';
        const gitError = stderr || (error instanceof Error ? error.message : String(error));
        const exitCode =
            typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number'
                ? error.code
                : undefined;
        const command = `git ${args.map((arg) => JSON.stringify(arg)).join(' ')}`;
        super(`Command: ${command}\nGit error: ${gitError}`);
        this.name = 'GitCommandError';
        this.args = [...args];
        this.gitError = gitError;
        this.exitCode = exitCode;
        this.cause = error;
    }

    addOperationContext(operation: string): void {
        this.message = `Failed to ${operation}.\n${this.message}`;
    }
}

/** Runs Git asynchronously, passing each argument directly to Git without a shell. */
export const runGitCommand = async (args: string[], cwd?: string): Promise<string> => {
    logger.debug('git', args);
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }).catch(
        (error: unknown) => {
            const err = new GitCommandError(args, error);
            logger.debug('git command failed:\n', err);
            throw err;
        },
    );
    return stdout.trim();
};

export const getEnvVar = (varName: string, defaultValue?: string): string => {
    const value = process.env[varName] ?? defaultValue;
    if (!value) {
        throw new Error(`${varName} not defined`);
    }
    return value;
};
