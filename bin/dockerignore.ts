import fs from 'node:fs';

import ignore from 'ignore';

import type { RelativeDir, RelativeFile } from './utils/path/repo-relative.js';

export type DockerIgnoreMatcher = (repoRelativePath: string) => boolean;

// Docker normalizes each pattern before matching, so a leading "./" (as in the common "./node_modules"
// style) is a no-op for Docker. The `ignore` package has no such normalization — it treats "./" as
// literal pattern text that can never match a real path, so a .dockerignore written in that style
// would otherwise silently match nothing. Strip it here (after any negation prefix) so the pattern
// behaves the way Docker itself would apply it.
const normalizeDockerignorePattern = (line: string): string => line.replace(/^(!?)(?:\.\/)+/, '$1');

/**
 * Reads a `.dockerignore` file and returns a matcher for repo-relative paths within its parent
 * directory. Paths outside that directory never match. Matching is performed on paths relative to
 * the `.dockerignore` file's parent, and leading `./` prefixes are removed from patterns to match
 * Docker's normalization behavior.
 *
 * Returns a matcher that always returns `false` if the file cannot be read.
 */
export const buildDockerIgnoreMatcher = (dockerIgnore: RelativeFile): DockerIgnoreMatcher => {
    let content: string;
    try {
        content = fs.readFileSync(dockerIgnore.path, 'utf-8');
    } catch {
        return () => false;
    }

    const matcher = ignore().add(content.split('\n').map(normalizeDockerignorePattern).join('\n'));
    const rootDir = dockerIgnore.parent;
    return (filePath: string): boolean => {
        if (!rootDir.containsPath(filePath)) {
            return false;
        }

        return matcher.ignores(rootDir.relativePathTo(filePath));
    };
};

/**
 * Loads `.dockerignore` from the root of `dockerContextDir` and returns a matcher that accepts
 * repo-relative file paths. Patterns are matched relative to `dockerContextDir`, consistent with
 * Docker's build-context behavior. If the file cannot be read, the matcher always returns `false`.
 */
export const loadDockerIgnore = (dockerContextDir: RelativeDir): DockerIgnoreMatcher => {
    try {
        const dockerIgnorePath = dockerContextDir.joinFile('.dockerignore');
        return buildDockerIgnoreMatcher(dockerIgnorePath);
    } catch {
        console.warn(`[.dockerignore] not found in "${dockerContextDir}".`);
        return () => false;
    }
};
