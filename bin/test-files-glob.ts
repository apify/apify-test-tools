import fs from 'node:fs/promises';
import path from 'node:path';

import picomatch from 'picomatch';

/**
 * `--test-files-glob` is one glob from the repo root, e.g. `test/platform/**`. `get-affected-actors` matches changed
 * files against it and `test` runs the files it matches, so both read it with these same options.
 */
const PICOMATCH_OPTIONS = { nocase: true, dot: true } as const;

/** Never walked: they hold no test files of the repo, and node_modules can be huge. */
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

const assertRelativeGlob = (glob: string) => {
    if (path.posix.isAbsolute(glob) || path.win32.isAbsolute(glob)) {
        throw new Error(`--test-files-glob must be relative to the repo root, got "${glob}".`);
    }
};

/** Tells whether a repo-root-relative path matches the glob. Without a glob, nothing matches. */
export const createTestFilesMatcher = (glob?: string): ((filePath: string) => boolean) => {
    if (!glob) return () => false;
    assertRelativeGlob(glob);
    const isMatch = picomatch(glob, PICOMATCH_OPTIONS);
    // One argument only: picomatch's second one returns a truthy object, and Array#filter passes the index there
    return (filePath) => isMatch(filePath);
};

/** Lists the files under `dir`, as POSIX paths relative to `cwd`. A missing `dir` has no files. */
const listFiles = async (cwd: string, dir: string): Promise<string[]> => {
    let entries;
    try {
        entries = await fs.readdir(path.join(cwd, dir), { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
        const entryPath = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) files.push(...(await listFiles(cwd, entryPath)));
        } else if (entry.isFile()) {
            files.push(entryPath);
        }
    }
    return files;
};

/**
 * Finds the files the glob matches, as repo-root-relative POSIX paths, sorted. `cwd` is the repo root. Only the
 * glob's static base (`test/platform` for `test/platform/{daily,hourly}/**`) is walked.
 */
export const resolveTestFilesGlob = async (glob: string, cwd: string): Promise<string[]> => {
    const isMatch = createTestFilesMatcher(glob);
    const { base } = picomatch.scan(glob);
    // join normalizes, so `./test` is listed as `test/...`, the way git prints paths
    const files = await listFiles(cwd, path.posix.normalize(base || '.'));
    return files.filter(isMatch).sort();
};
