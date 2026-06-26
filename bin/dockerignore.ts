import fs from 'node:fs';
import path from 'node:path';

import ignore from 'ignore';

export type DockerIgnoreMatcher = (repoRelativePath: string) => boolean;

/**
 * Load .dockerignore from the root of an actor's dockerContextDir and return a matcher
 * that accepts repo-root-relative file paths. Patterns are resolved relative to
 * dockerContextDir, matching Docker's own behavior.
 *
 * Returns a no-op matcher (always returns false) when the file is absent.
 */
export const loadDockerIgnore = (dockerContextDir: string): DockerIgnoreMatcher => {
    const dockerignorePath = dockerContextDir ? path.join(dockerContextDir, '.dockerignore') : '.dockerignore';

    let content: string;
    try {
        content = fs.readFileSync(dockerignorePath, 'utf-8');
    } catch {
        return () => false;
    }

    const matcher = ignore().add(content);

    return (repoRelativePath: string): boolean => {
        const lowerPath = repoRelativePath.toLowerCase();
        const lowerContext = dockerContextDir.toLowerCase();

        // Strip the dockerContextDir prefix to get a path relative to the context root
        let relativePath: string;
        if (lowerContext === '') {
            relativePath = repoRelativePath;
        } else if (lowerPath.startsWith(`${lowerContext}/`)) {
            relativePath = repoRelativePath.slice(dockerContextDir.length + 1);
        } else {
            return false;
        }

        return matcher.ignores(relativePath);
    };
};
