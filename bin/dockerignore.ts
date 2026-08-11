import fs from 'node:fs';
import path from 'node:path';

import ignore from 'ignore';

import { hoistPath, isPathWithinScope } from './path-utils.js';

export type DockerIgnoreMatcher = (repoRelativePath: string) => boolean;

// Docker normalizes each pattern before matching, so a leading "./" (as in the common "./node_modules"
// style) is a no-op for Docker. The `ignore` package has no such normalization — it treats "./" as
// literal pattern text that can never match a real path, so a .dockerignore written in that style
// would otherwise silently match nothing. Strip it here (after any negation prefix) so the pattern
// behaves the way Docker itself would apply it.
const normalizeDockerignorePattern = (line: string): string => line.replace(/^(!?)(?:\.\/)+/, '$1');

/**
 * Reads `.dockerignore` from `absoluteRootDir` and returns a matcher for paths relative to
 * `hoistFrom`. `hoistFrom` defaults to '', meaning callers already pass paths relative to
 * `absoluteRootDir` directly — isPathWithinScope/hoistPath both treat '' as "matches everything" /
 * identity, so the scope-check and hoist collapse to a no-op in that case, not via a branch.
 *
 * Returns a no-op matcher (always returns false) when the file is absent.
 */
export const buildDockerIgnoreMatcher = (absoluteRootDir: string, hoistFrom = ''): DockerIgnoreMatcher => {
    let content: string;
    try {
        content = fs.readFileSync(path.join(absoluteRootDir, '.dockerignore'), 'utf-8');
    } catch {
        return () => false;
    }

    const matcher = ignore().add(content.split('\n').map(normalizeDockerignorePattern).join('\n'));

    return (filePath: string): boolean => {
        if (!isPathWithinScope(filePath.toLowerCase(), hoistFrom.toLowerCase())) {
            return false;
        }

        return matcher.ignores(hoistPath(filePath, hoistFrom));
    };
};

/**
 * Load .dockerignore from the root of an actor's dockerContextDir and return a matcher
 * that accepts repo-root-relative file paths. Patterns are resolved relative to
 * dockerContextDir, matching Docker's own behavior.
 */
export const loadDockerIgnore = (dockerContextDir: string): DockerIgnoreMatcher =>
    buildDockerIgnoreMatcher(path.resolve(dockerContextDir), dockerContextDir);
