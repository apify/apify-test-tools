import path from 'node:path';

import { loadDockerIgnore } from './dockerignore.js';
import { getGitignoredPaths, listRepoFilePaths } from './utils.js';
import type { RelativeDir } from './utils/path/repo-relative.js';

// JUST IN CASE. File patterns that commonly hold credentials — never ship these into a build, regardless
// of sourceType or of whether the repo's .gitignore happens to list them. Everything else that should be
// excluded (build output, local overrides, project-specific secret files, ...) is expected to already be
// in the repo's .gitignore — see collectNonIgnoredFiles.
const SKIP_FILE_PATTERNS = [/^\.env(\..+)?$/, /\.pem$/, /\.key$/, /\.pfx$/, /\.p12$/];
const isSecretFile = (fileName: string): boolean => SKIP_FILE_PATTERNS.some((pattern) => pattern.test(fileName));

// Candidates come from `git ls-files` (tracked + untracked, gitignored included) rather than a
// manual directory walk — nested .gitignore files, `.git/info/exclude`, and global excludes are
// all honored since this delegates to git itself instead of re-implementing gitignore matching,
// and .git/ is never walked because git never lists its own internals here. `.dockerignore` at
// `dockerContextDir` (the Docker build context) is honored the same way, since those files would
// never reach a real Docker build either. `.actor/` (the Actor specification folder) is always kept
// regardless of .gitignore/.dockerignore, matching Apify CLI's own behavior. Files matching the
// hardcoded secret-pattern backstop (keys, certs, .env variants) are dropped unconditionally,
// .actor/ included, since those should never ship regardless of what the ignore files say.
export const collectNonIgnoredFiles = async (dockerContextDir: RelativeDir, repoRoot: string): Promise<string[]> => {
    const relativePaths = await listRepoFilePaths(repoRoot, path.resolve(repoRoot, dockerContextDir.path));
    const ignoredPaths = await getGitignoredPaths(relativePaths, repoRoot);
    const isDockerIgnored = loadDockerIgnore(dockerContextDir);

    return relativePaths
        .filter((relPath) => {
            if (isSecretFile(path.basename(relPath))) return false;
            const isUnderActorDir = relPath.split('/').includes('.actor');
            if (isUnderActorDir) return true;
            if (ignoredPaths.has(relPath)) return false;
            return !isDockerIgnored(relPath);
        })
        .map((relPath) => path.join(repoRoot, relPath));
};
