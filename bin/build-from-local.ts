import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ActorVersionSourceFile } from 'apify-client';

import { ApifyBuilder, waitAndSummarizeBuilds } from './build.js';
import { buildDockerIgnoreMatcher } from './dockerignore.js';
import { isPathWithinScope } from './path-utils.js';
import type { ActorConfig, BuildData } from './types.js';
import { getGitignoredPaths, isOutsideDir, listRepoFilePaths, toActorVersionSourceFile } from './utils.js';

// JUST IN CASE. File patterns that commonly hold credentials — never ship these into a build, regardless
// of sourceType or of whether the repo's .gitignore happens to list them. Everything else that should be
// excluded (build output, local overrides, project-specific secret files, ...) is expected to already be
// in the repo's .gitignore — see collectNonIgnoredFiles.
const SKIP_FILE_PATTERNS = [/^\.env(\..+)?$/, /\.pem$/, /\.key$/, /\.pfx$/, /\.p12$/];
const isSecretFile = (fileName: string): boolean => SKIP_FILE_PATTERNS.some((pattern) => pattern.test(fileName));

export const collectSourceFiles = async (actorName: string, actorDir: string): Promise<ActorVersionSourceFile[]> => {
    const repoRoot = process.cwd();
    const absActorDir = path.resolve(actorDir);

    // Read actor.json to check if this is a monorepo actor with an external dockerContextDir.
    // Monorepo actors point their dockerContextDir to a parent directory (e.g. "../../.."),
    // which means the Docker build context is the repo root, not the actor directory itself.
    const actorJsonPath = path.join(absActorDir, '.actor', 'actor.json');
    const actorJson = JSON.parse(await fs.readFile(actorJsonPath, 'utf8')) as Record<string, unknown>;
    const rawContextDir = actorJson.dockerContextDir as string | undefined;
    const contextAbsDir = rawContextDir ? path.resolve(absActorDir, '.actor', rawContextDir) : undefined;
    const isMonorepoActor = !!contextAbsDir && isOutsideDir(contextAbsDir, absActorDir);

    const dockerContextDirAbs = isMonorepoActor ? contextAbsDir! : absActorDir;
    const keptFilePaths = collectNonIgnoredFiles(dockerContextDirAbs, repoRoot);

    if (!isMonorepoActor) {
        return Promise.all(
            keptFilePaths.map(async (filePath) => toActorVersionSourceFile(filePath, dockerContextDirAbs)),
        );
    }

    const { tempDir, filePaths } = await flattenMonorepoContext(
        actorName,
        absActorDir,
        contextAbsDir!,
        actorJson,
        keptFilePaths,
    );
    try {
        return await Promise.all(filePaths.map(async (filePath) => toActorVersionSourceFile(filePath, tempDir)));
    } finally {
        // Only the flattened copy is temporary — never delete the actor's own directory.
        await fs.rm(tempDir, { recursive: true, force: true });
    }
};

// Candidates come from `git ls-files` (tracked + untracked, gitignored included) rather than a
// manual directory walk — nested .gitignore files, `.git/info/exclude`, and global excludes are
// all honored since this delegates to git itself instead of re-implementing gitignore matching,
// and .git/ is never walked because git never lists its own internals here. `.dockerignore` at
// `dockerContextDir` (the Docker build context) is honored the same way, since those files would
// never reach a real Docker build either. `.actor/` (the Actor specification folder) is always kept
// regardless of .gitignore/.dockerignore, matching Apify CLI's own behavior. Files matching the
// hardcoded secret-pattern backstop (keys, certs, .env variants) are dropped unconditionally,
// .actor/ included, since those should never ship regardless of what the ignore files say.
export const collectNonIgnoredFiles = (dockerContextDir: string, repoRoot: string): string[] => {
    const relativePaths = listRepoFilePaths(repoRoot, dockerContextDir);
    const ignoredPaths = getGitignoredPaths(relativePaths);
    const rootRelativePaths = new Map(
        relativePaths.map((relPath) => [
            relPath,
            path.relative(dockerContextDir, path.join(repoRoot, relPath)).split(path.sep).join('/'),
        ]),
    );
    const isDockerIgnored = buildDockerIgnoreMatcher(dockerContextDir);

    return relativePaths
        .filter((relPath) => {
            if (isSecretFile(path.basename(relPath))) return false;
            const isUnderActorDir = relPath.split('/').includes('.actor');
            if (isUnderActorDir) return true;
            if (ignoredPaths.has(relPath)) return false;
            return !isDockerIgnored(rootRelativePaths.get(relPath)!);
        })
        .map((relPath) => path.join(repoRoot, relPath));
};

// SOURCE_FILES always treats the collected root as the actor root, so we cannot simply
// collect the actor directory of a monorepo actor — the platform would reject any path
// escaping it. Fix: create a temporary "flattened" directory where:
//   - the Docker context's non-ignored files (repo root) are copied to the temp dir root
//   - the actor's own .actor/ directory (already present within those same non-ignored files)
//     is overlaid at the temp dir root instead of its original nested position
//   - actor.json path fields are rewritten to be relative to the new location
//
// Result: the collected root IS the Docker context, .actor/ is at that root, and
// all relative paths (dockerfile, dockerContextDir, changelog) are exactly one
// level up ("..") instead of three ("../../..").
export const flattenMonorepoContext = async (
    actorName: string,
    absActorDir: string,
    contextAbsDir: string,
    actorJson: Record<string, unknown>,
    keptContextFiles: string[],
): Promise<{ tempDir: string; filePaths: string[] }> => {
    console.error(`[${actorName}]: monorepo actor detected — flattening from Docker context`);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `apify-build-${actorName.replace('/', '_')}-`));
    const filePaths: string[] = [];

    // Step 1: copy only the files that survived gitignore/secret filtering, preserving their
    // position relative to the Docker context root.
    await Promise.all(
        keptContextFiles.map(async (absFilePath) => {
            const relPath = path.relative(contextAbsDir, absFilePath);
            const destPath = path.join(tempDir, relPath);
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.copyFile(absFilePath, destPath);
            filePaths.push(destPath);
        }),
    );

    // Step 2: overlay the actor's own .actor/ directory at the temp dir root. Its files are already
    // present in keptContextFiles (collectNonIgnoredFiles keeps .actor/ paths unconditionally — see
    // step 1 above) — pick out this actor's own subset (ignoring any sibling actors' .actor/ folders
    // that might also appear in the broader context) and hoist each to its position relative to
    // .actor/ itself, so it lands under tempDir/.actor/ instead of its original nested location.
    const actorMetaDir = path.join(absActorDir, '.actor');
    const keptActorFiles = keptContextFiles.filter((absFilePath) => isPathWithinScope(absFilePath, actorMetaDir));
    await Promise.all(
        keptActorFiles.map(async (absFilePath) => {
            const relPath = path.relative(actorMetaDir, absFilePath);
            const destPath = path.join(tempDir, '.actor', relPath);
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.copyFile(absFilePath, destPath);
            filePaths.push(destPath);
        }),
    );

    // Step 3: rewrite actor.json path fields so they resolve correctly from the new location.
    // This overwrites the actor.json already copied in step 2 in place, so its path is already
    // accounted for in filePaths — no need to add it again.
    await rewriteActorJsonPaths(absActorDir, contextAbsDir, tempDir, actorJson);

    return { tempDir, filePaths };
};

// Rewrites actor.json path fields so they resolve correctly from the new .actor/ location
// (one level below the root) instead of the original three-levels-deep location.
//
// Algorithm for each path field:
//   1. Resolve the original value to an absolute path on disk.
//   2. Compute its position relative to the Docker context root (e.g. repo root).
//      That relative position is exactly where the file landed inside tempDir,
//      because we copied contextAbsDir → tempDir in flattenMonorepoContext's step 1.
//   3. Build the new path from newActorDir to that file in tempDir.
//
// Local paths (e.g. "./dataset_schema.json") point inside .actor/ and are left
// unchanged — .actor/ was copied intact so those paths still resolve correctly.
export const rewriteActorJsonPaths = async (
    absActorDir: string,
    contextAbsDir: string,
    tempDir: string,
    actorJson: Record<string, unknown>,
): Promise<void> => {
    const originalActorDir = path.join(absActorDir, '.actor');
    const newActorDir = path.join(tempDir, '.actor');
    const pathFields = ['dockerfile', 'dockerContextDir', 'changelog', 'readme'] as const;
    const rewritten = { ...actorJson };
    for (const field of pathFields) {
        const value = rewritten[field];
        if (typeof value !== 'string') continue;

        const absPath = path.resolve(originalActorDir, value);

        // Skip paths that stay inside .actor/ — they don't need rewriting.
        if (!isOutsideDir(absPath, originalActorDir)) continue;

        // Where does this file live inside the Docker context? That's also where
        // it lives inside tempDir after the copy in flattenMonorepoContext's step 1.
        const relativeToContext = path.relative(contextAbsDir, absPath);
        const newAbsPath = path.join(tempDir, relativeToContext);
        rewritten[field] = path.relative(newActorDir, newAbsPath);
    }
    await fs.writeFile(path.join(newActorDir, 'actor.json'), JSON.stringify(rewritten, null, 4));
};

export const runBuildsFromLocal = async ({
    actorConfigs,
    dryRun,
}: {
    actorConfigs: ActorConfig[];
    dryRun: boolean;
}): Promise<BuildData[]> => {
    if (dryRun) {
        console.error('[DRY RUN] Would build from local source:');
        for (const { actorFullName, folder } of actorConfigs) {
            console.error(`  ${actorFullName} (${folder})`);
        }
        return actorConfigs.map(({ actorFullName }) => ({
            buildId: 'dry-run',
            actorRawId: 'dry-run',
            buildNumber: '0.98.0',
            actorFullName,
        }));
    }

    console.error('=========================================');
    console.error('STARTED LOCAL BUILDS:');
    const buildersByActorFullName = new Map<string, ApifyBuilder>(
        actorConfigs.map((actorConfig) => [actorConfig.actorFullName, ApifyBuilder.fromActorConfig(actorConfig)]),
    );
    const startedBuilds = await Promise.all(
        actorConfigs.map(async ({ actorFullName, folder }) => {
            const builder = buildersByActorFullName.get(actorFullName)!;
            const sourceFiles = await collectSourceFiles(actorFullName, folder);
            return builder.startActorBuildFromSourceFiles(sourceFiles);
        }),
    );

    return waitAndSummarizeBuilds(startedBuilds, buildersByActorFullName, 'LOCAL BUILDS');
};
