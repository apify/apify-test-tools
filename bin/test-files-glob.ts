import fs from 'node:fs/promises';
import path from 'node:path';

import picomatch from 'picomatch';

/**
 * Test globs are from the repo root, e.g. `test/platform/**`. `get-affected-actors` matches changed files against the
 * config's `platformTestsGlob` and `test` runs the files `--test-files-glob` matches, so both read globs the same way.
 */
const PICOMATCH_OPTIONS = { nocase: true, dot: true } as const;

/** Never walked: they hold no test files of the repo, and node_modules can be huge. */
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

const assertRelativeGlob = (glob: string) => {
    if (path.posix.isAbsolute(glob) || path.win32.isAbsolute(glob)) {
        throw new Error(`Test file globs must be relative to the repo root, got "${glob}".`);
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

interface Listing {
    /** POSIX paths relative to `cwd` */
    files: string[];
    /** What wasn't walked (skipped directories, symlinks), so the folders holding them never count as fully matched */
    skipped: string[];
}

/** Lists the files under `dir`. A missing `dir` has no files. */
const listFiles = async (cwd: string, dir: string): Promise<Listing> => {
    let entries;
    try {
        entries = await fs.readdir(path.join(cwd, dir), { withFileTypes: true });
    } catch (error) {
        const { code } = error as NodeJS.ErrnoException;
        if (code === 'ENOENT') return { files: [], skipped: [] };
        // A glob without wildcards has the file itself as its base
        if (code === 'ENOTDIR') return { files: [dir], skipped: [] };
        throw error;
    }
    const listing: Listing = { files: [], skipped: [] };
    for (const entry of entries) {
        const entryPath = path.posix.join(dir, entry.name);
        if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
            const inner = await listFiles(cwd, entryPath);
            listing.files.push(...inner.files);
            listing.skipped.push(...inner.skipped);
        } else if (entry.isFile()) {
            listing.files.push(entryPath);
        } else {
            listing.skipped.push(entryPath);
        }
    }
    return listing;
};

const isWithin = (dir: string, base: string) => base === '.' || dir === base || dir.startsWith(`${base}/`);

/**
 * The directories from `base` down to the file's own directory, `base` first. None when `base` is the file itself,
 * as for a glob without wildcards.
 */
const dirsFromBase = (file: string, base: string): string[] => {
    const dirs: string[] = [];
    for (let dir = path.posix.dirname(file); isWithin(dir, base); dir = path.posix.dirname(dir)) {
        dirs.unshift(dir);
        if (dir === base || dir === '.') break;
    }
    return dirs;
};

/**
 * Turns the matched files into as few paths as possible: a directory, with a trailing `/`, where the glob matches
 * every file in it, and a single file otherwise. `test/platform/{daily,hourly}/**` gives two paths however many
 * tests the folders hold, so the vitest command line stays short.
 */
const toCoveringPaths = ({ files, skipped }: Listing, matched: Set<string>, base: string): string[] => {
    const counts = new Map<string, { total: number; matched: number }>();
    for (const file of [...files, ...skipped]) {
        for (const dir of dirsFromBase(file, base)) {
            const count = counts.get(dir) ?? { total: 0, matched: 0 };
            count.total += 1;
            if (matched.has(file)) count.matched += 1;
            counts.set(dir, count);
        }
    }
    const isCovered = (dir: string) => counts.get(dir)!.total === counts.get(dir)!.matched;
    const paths = new Set<string>();
    for (const file of matched) {
        // The highest directory that holds only matched files, so its children are not listed one by one
        const coveredDir = dirsFromBase(file, base).find(isCovered);
        paths.add(coveredDir === undefined ? file : `${coveredDir}/`);
    }
    return [...paths].sort();
};

interface ResolvedTestFiles {
    /** Every file the glob matches, as repo-root-relative POSIX paths, sorted */
    files: string[];
    /**
     * The same files as few paths as possible: directories (ending with `/`) that hold only matched files, and the
     * other matched files one by one. Sorted.
     */
    paths: string[];
}

/**
 * Finds the files the glob matches. `cwd` is the repo root. Only the glob's static base (`test/platform` for
 * `test/platform/{daily,hourly}/**`) is walked.
 */
export const resolveTestFilesGlob = async (glob: string, cwd: string): Promise<ResolvedTestFiles> => {
    const isMatch = createTestFilesMatcher(glob);
    // normalize turns `./test` into `test`, the way git prints paths
    const base = path.posix.normalize(picomatch.scan(glob).base || '.');
    const listing = await listFiles(cwd, base);
    const files = listing.files.filter(isMatch).sort();
    return { files, paths: toCoveringPaths(listing, new Set(files), base) };
};
