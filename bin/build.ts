import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ActorVersionSourceFile, Build } from 'apify-client';
import { ApifyClient } from 'apify-client';

import { ACTOR_SOURCE_TYPES } from '@apify/consts';

import type { ActorConfig, BuildData } from './types.js';
import { collectFilePaths, getGitignoredPaths, isOutsideDir, toSourceFile } from './utils.js';

const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'apify_storage',
    'storage',
    'crawlee_storage',
    'dist',
    'build',
    'out',
    '.next',
    '.cache',
]);

// JUST IN CASE. File patterns that commonly hold credentials — never ship these into a build, regardless
// of sourceType or of whether the repo's .gitignore happens to list them. Everything else that should be
// excluded (build output, local overrides, project-specific secret files, ...) is expected to already be
// in the repo's .gitignore — see getGitignoredPaths.
const SKIP_FILE_PATTERNS = [/^\.env(\..+)?$/, /\.pem$/, /\.key$/, /\.pfx$/, /\.p12$/];
const isSecretFile = (fileName: string): boolean => SKIP_FILE_PATTERNS.some((pattern) => pattern.test(fileName));

type BuildPrActorOptions = {
    buildTag?: string;
    versionNumber: string;
    gitRepoUrl: string;
    actorName: string;
    useDockerCache: boolean;
};
export class ApifyBuilder {
    private constructor(
        private readonly apifyClient: ApifyClient,
        private readonly actorName: string,
    ) {}

    // Usually 'latest' but not necessarily (can be e.g. 'version-0')
    getDefaultVersionAndTag = async (): Promise<{
        defaultBuildNumber: string;
        defaultVersionNumber: string;
        defaultBuildTag: string;
    }> => {
        const actorClient = this.apifyClient.actor(this.actorName);
        const actorInfo = await actorClient.get();

        if (!actorInfo) {
            throw new Error(
                `[${this.actorName}] not found. It is not published or we are missing token to access it privately or its name is misspelled`,
            );
        }

        const defaultBuildTag = actorInfo.defaultRunOptions.build;
        console.error(`Default build tag for ${this.actorName} is ${defaultBuildTag}`);

        // We could technically allow this but in most cases this is accidentally set wrongly and there is a workaround
        if (defaultBuildTag.match(/\d+\.\d+\.\d+/)) {
            throw new Error(
                `[${this.actorName}] Default build is a build number, not a tag. While this could work, ` +
                    `we want to have a default as tag so this is often an accidental misconfiguration from the dev`,
            );
        }
        // I reported that buildNumber should probably not be optional
        if (!actorInfo.taggedBuilds?.[defaultBuildTag]?.buildNumber) {
            throw new Error(
                `[${this.actorName}] No build found for tag "${defaultBuildTag}". ` +
                    `The first build must be triggered manually on the platform before CI can take over.`,
            );
        }
        const defaultBuildNumber = actorInfo.taggedBuilds![defaultBuildTag].buildNumber!;
        const defaultVersionNumber = defaultBuildNumber.match(/(\d+\.\d+)\.\d+/)![1];
        console.error(`Default version for ${this.actorName} is ${defaultVersionNumber}`);

        return { defaultBuildNumber, defaultVersionNumber, defaultBuildTag };
    };

    startActorBuild = async ({
        buildTag,
        versionNumber,
        gitRepoUrl,
        useDockerCache,
    }: BuildPrActorOptions): Promise<BuildData> => {
        const actorClient = this.apifyClient.actor(this.actorName);
        const actorInfo = await actorClient.get();
        if (!actorInfo) {
            throw new Error(
                `No actor named '${this.actorName}' was found on the platform. If this` +
                    ' is unexpected, make sure the actor you are targeting is spelled the' +
                    ' same as the folder in the repository.',
            );
        }

        // NOTE: I couldn't find this type, so I had to extract it :(
        type ActorVersion = Parameters<ReturnType<typeof actorClient.version>['update']>[0];
        const actorVersion: ActorVersion = {
            buildTag,
            versionNumber,
            gitRepoUrl,
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore: coudn't find this type either :(
            sourceType: ACTOR_SOURCE_TYPES.GIT_REPO,
        };

        // Prepare version
        const versionExists = !actorInfo.versions.find((version) => version.versionNumber === versionNumber);
        if (versionExists) {
            // create new version
            await actorClient.versions().create(actorVersion);
        } else {
            const version = actorClient.version(versionNumber);
            await version.update(actorVersion);
        }

        // We also get back actId so the testing actor can both match by actor ID and name
        const { id, actId, buildNumber } = await actorClient.build(versionNumber, { useCache: useDockerCache });

        console.error(`[${this.actorName}]: ${id} (${buildNumber})`);
        return { buildId: id, actorId: actId, buildNumber, actorName: this.actorName };
    };

    startActorBuildFromSourceFiles = async (sourceFiles: ActorVersionSourceFile[]): Promise<BuildData> => {
        const ZIP_VERSION = '0.98';
        const actorClient = this.apifyClient.actor(this.actorName);
        const actorInfo = await actorClient.get();
        if (!actorInfo) {
            throw new Error(
                `No actor named '${this.actorName}' was found on the platform. If this` +
                    ' is unexpected, make sure the actor you are targeting is spelled the' +
                    ' same as the folder in the repository.',
            );
        }

        type ActorVersion = Parameters<ReturnType<typeof actorClient.version>['update']>[0];
        const actorVersion: ActorVersion = {
            versionNumber: ZIP_VERSION,
            sourceFiles,
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore: couldn't find this type :(
            sourceType: ACTOR_SOURCE_TYPES.SOURCE_FILES,
        };

        const versionExists = !actorInfo.versions.find((v) => v.versionNumber === ZIP_VERSION);
        if (versionExists) {
            await actorClient.versions().create(actorVersion);
        } else {
            await actorClient.version(ZIP_VERSION).update(actorVersion);
        }

        const { id, actId, buildNumber } = await actorClient.build(ZIP_VERSION, { useCache: false });
        console.error(`[${this.actorName}]: ${id} (${buildNumber})`);
        return { buildId: id, actorId: actId, buildNumber, actorName: this.actorName };
    };

    collectSourceFiles = async (actorDir: string): Promise<ActorVersionSourceFile[]> => {
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

        const collectRootDir = isMonorepoActor ? contextAbsDir! : absActorDir;
        const keptFilePaths = await this.collectNonIgnoredFiles(collectRootDir, repoRoot);

        const sourceRootDir = isMonorepoActor
            ? await this.flattenMonorepoContext(absActorDir, contextAbsDir!, actorJson, keptFilePaths, repoRoot)
            : collectRootDir;

        try {
            // The flattened temp dir already contains exactly the files we want (kept files +
            // the .actor/ overlay), so it's walked fresh; the non-monorepo case reuses keptFilePaths directly.
            const filePaths = isMonorepoActor ? await collectFilePaths(sourceRootDir, SKIP_DIRS) : keptFilePaths;
            const sourceFiles = await Promise.all(
                filePaths.map(async (filePath) => toSourceFile(filePath, sourceRootDir)),
            );

            return sourceFiles;
        } finally {
            // Only the flattened copy is temporary — never delete the actor's own directory.
            if (isMonorepoActor) {
                await fs.rm(sourceRootDir, { recursive: true, force: true });
            }
        }
    };

    // Walks `rootDir` and drops anything the repo's .gitignore excludes — nested .gitignore files,
    // `.git/info/exclude`, and global excludes are all honored since this delegates to `git check-ignore`
    // instead of re-implementing gitignore matching. `.actor/` (the Actor specification folder) is always
    // kept regardless of .gitignore, matching Apify CLI's own behavior. Files matching the hardcoded
    // secret-pattern backstop (keys, certs, .env variants) are dropped unconditionally, .actor/ included,
    // since those should never ship regardless of what .gitignore says.
    collectNonIgnoredFiles = async (rootDir: string, repoRoot: string): Promise<string[]> => {
        const candidatePaths = await collectFilePaths(rootDir, SKIP_DIRS);
        const relativePaths = candidatePaths.map((absPath) =>
            path.relative(repoRoot, absPath).split(path.sep).join('/'),
        );
        const ignoredPaths = getGitignoredPaths(relativePaths);

        return candidatePaths.filter((absPath, i) => {
            if (isSecretFile(path.basename(absPath))) return false;
            const isUnderActorDir = relativePaths[i].split('/').includes('.actor');
            return isUnderActorDir || !ignoredPaths.has(relativePaths[i]);
        });
    };

    // SOURCE_FILES always treats the collected root as the actor root, so we cannot simply
    // collect the actor directory of a monorepo actor — the platform would reject any path
    // escaping it. Fix: create a temporary "flattened" directory where:
    //   - the Docker context's non-ignored files (repo root) are copied to the temp dir root
    //   - the actor's .actor/ directory is overlaid at the temp dir root (through the same
    //     gitignore/secret-pattern filter as the rest of the context — see collectNonIgnoredFiles)
    //   - actor.json path fields are rewritten to be relative to the new location
    //
    // Result: the collected root IS the Docker context, .actor/ is at that root, and
    // all relative paths (dockerfile, dockerContextDir, changelog) are exactly one
    // level up ("..") instead of three ("../../..").
    flattenMonorepoContext = async (
        absActorDir: string,
        contextAbsDir: string,
        actorJson: Record<string, unknown>,
        keptContextFiles: string[],
        repoRoot: string,
    ): Promise<string> => {
        console.error(`[${this.actorName}]: monorepo actor detected — flattening from Docker context`);

        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `apify-build-${this.actorName.replace('/', '_')}-`));

        // Step 1: copy only the files that survived gitignore/secret filtering, preserving their
        // position relative to the Docker context root.
        await Promise.all(
            keptContextFiles.map(async (absFilePath) => {
                const relPath = path.relative(contextAbsDir, absFilePath);
                const destPath = path.join(tempDir, relPath);
                await fs.mkdir(path.dirname(destPath), { recursive: true });
                await fs.copyFile(absFilePath, destPath);
            }),
        );

        // Step 2: overlay the actor's .actor/ directory at the temp dir root. collectNonIgnoredFiles
        // always keeps .actor/ paths regardless of .gitignore, but still drops the hardcoded secret
        // patterns — so this isn't a raw copy, a stray secret file living inside .actor/ is still dropped.
        const actorMetaDir = path.join(absActorDir, '.actor');
        const keptActorFiles = await this.collectNonIgnoredFiles(actorMetaDir, repoRoot);
        await Promise.all(
            keptActorFiles.map(async (absFilePath) => {
                const relPath = path.relative(actorMetaDir, absFilePath);
                const destPath = path.join(tempDir, '.actor', relPath);
                await fs.mkdir(path.dirname(destPath), { recursive: true });
                await fs.copyFile(absFilePath, destPath);
            }),
        );

        // Step 3: rewrite actor.json path fields so they resolve correctly from the new location.
        await this.rewriteActorJsonPaths(absActorDir, contextAbsDir, tempDir, actorJson);

        return tempDir;
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
    rewriteActorJsonPaths = async (
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

    waitForBuildToFinish = async (buildId: string, actorName: string): Promise<Build> => {
        const build = await this.apifyClient.build(buildId).waitForFinish();
        const versionNumber = build.buildNumber;
        if (build.status === 'FAILED' || build.status === 'TIMED-OUT') {
            console.error(`[${this.actorName}]: ${versionNumber}`);
            try {
                const log = await this.apifyClient.build(buildId).log().get();
                const logTail = log?.split('\n').slice(-40).join('\n');
                console.error(`\n--- BUILD LOG (last 40 lines) ---\n${logTail}\n---`);
            } catch (err) {
                console.error(`[${this.actorName}]: Failed to fetch build log: ${err}`);
            }
            throw new Error(
                `[BUILD][${actorName}]: Build ${buildId} (${versionNumber}) failed. ` +
                    `Not continuing with other builds and tests.`,
            );
        }
        console.error(`[${this.actorName}]: ${versionNumber}`);
        return build;
    };

    /**
     * Create ApifyBuilder with actor owner's token
     */
    static fromActorName = (actorName: string): ApifyBuilder => {
        const username = actorName.split('/')[0];
        // GitHib secrets only allow word characters (alphanum + underscore)
        const usernameInGitHubSecretsFormat = username.replaceAll(/\W/g, '_').toUpperCase();
        const usernameEnvVar = `APIFY_TOKEN_${usernameInGitHubSecretsFormat}`;
        const token = process.env[usernameEnvVar];
        if (!token) {
            throw new Error(
                `Cannot find Apify API token for username: ${username}. ` +
                    `Have you set secret env var to this GitHub repo with key: ${usernameEnvVar}?`,
            );
        }
        const apifyClient = new ApifyClient({ token });
        const builder = new ApifyBuilder(apifyClient, actorName);
        return builder;
    };

    /**
     * Deletes build of all versions. Apify API doesn't allow to delete default build and we explicitly skip it
     * We delete devel builds faster because we used the for every PR until recently so just to get rid of them faster
     */
    async deleteOldBuilds(): Promise<void> {
        // Even though we don't version our current Actors, if we ever such Actors to GitHub CI, we would accidentally delete old supported versions
        // This hardcoded solution is not ideal, but it should prevent most imaginable cases
        // All currently popular versioned Actors use `version-${number}` format
        const PROTECTED_TAGS_PREFIX = [
            'latest',
            'v-',
            'version',
            'v0',
            'v1',
            'v2',
            'v3',
            'v4',
            'v5',
            'v6',
            'v7',
            'v8',
            'v9',
        ];

        // We don't want to be too short because we might to debug something
        // but also not too long because it increases the risk of users using outdated versions
        const DEFAULT_DAYS_BACK_PROD_VERSIONS = 30;
        const DEFAULT_DAYS_BACK_DEVEL = 7;

        const actorInfo = (await this.apifyClient.actor(this.actorName).get())!;

        // 'devel' used to be hardcoded for testing version 0.99, once we get rid of this tag everywhere, we can remove this code
        const taggedDevelBuildNumber: string | undefined = actorInfo.taggedBuilds!.devel?.buildNumber;

        const allTags = Object.keys(actorInfo.taggedBuilds ?? {});
        const protectedTags = allTags.filter((tag) => PROTECTED_TAGS_PREFIX.some((prefix) => tag.startsWith(prefix)));
        const protectedBuildNumbers = protectedTags.map((tag) => ({
            buildNumber: actorInfo.taggedBuilds![tag]!.buildNumber,
            tag,
        }));

        const { items } = await this.apifyClient.actor(this.actorName).builds().list();

        // Deleting default build throws an error, so we skip it
        const { defaultBuildNumber, defaultBuildTag } = await ApifyBuilder.fromActorName(
            this.actorName,
        ).getDefaultVersionAndTag();

        const daysAgoUnixProd = Date.now() - DEFAULT_DAYS_BACK_PROD_VERSIONS * 24 * 60 * 60 * 1000;
        const daysAgoUnixDevel = Date.now() - DEFAULT_DAYS_BACK_DEVEL * 24 * 60 * 60 * 1000;

        // Fixing API client missing buildNumber field
        type CorrectBuildColletionItem = (typeof items)[0] & { buildNumber: string };
        const buildsToDelete = (items as CorrectBuildColletionItem[]).filter((build) => {
            if (build.buildNumber === defaultBuildNumber) {
                console.error(
                    `[DELETE OLD BUILDS][${this.actorName}]: Skipping default build ${defaultBuildNumber} (${defaultBuildTag}). ` +
                        `We never delete default builds`,
                );
                return false;
            }

            const protectedTagFound = protectedBuildNumbers.find(
                (protectedBuildNumber) => protectedBuildNumber.buildNumber === build.buildNumber,
            );
            if (protectedTagFound) {
                console.error(
                    `[DELETE OLD BUILDS][${this.actorName}]: Skipping protected build ${protectedTagFound.buildNumber} (${protectedTagFound.tag}).`,
                );
                return false;
            }

            if (taggedDevelBuildNumber && build.buildNumber === taggedDevelBuildNumber) {
                const shouldDeleteDevelBuild = build.startedAt.getTime() < daysAgoUnixDevel;
                if (shouldDeleteDevelBuild) {
                    console.error(
                        `[DELETE OLD BUILDS][${this.actorName}]: Removing olf devel build ${taggedDevelBuildNumber}.`,
                    );
                }
                return shouldDeleteDevelBuild;
            }
            return build.startedAt.getTime() < daysAgoUnixProd;
        });

        console.error(
            `[DELETE OLD BUILDS][${this.actorName}]: Deleting ${buildsToDelete.length} old builds that are non-default and ` +
                `older than 30 days from total ${items.length}`,
        );
        for (const build of buildsToDelete) {
            await this.apifyClient.build(build.id).delete();
        }
    }
}

type RunBuildsOptions = {
    actorConfigs: ActorConfig[];
    isLatest?: boolean;
    repoUrl: string;
    branch: string;
    dryRun: boolean;
    useDockerCache: boolean;
};

export const runBuilds = async ({
    repoUrl,
    branch,
    actorConfigs,
    isLatest = false,
    dryRun,
    useDockerCache,
}: RunBuildsOptions) => {
    const buildConfigs: BuildPrActorOptions[] = [];

    for (const { actorName, folder } of actorConfigs) {
        let versionNumber: string;
        let buildTag: string | undefined;

        if (isLatest) {
            const { defaultVersionNumber, defaultBuildTag } =
                await ApifyBuilder.fromActorName(actorName).getDefaultVersionAndTag();
            versionNumber = defaultVersionNumber;
            buildTag = defaultBuildTag;
        } else {
            versionNumber = '0.99';
        }

        // Depending on if these are miniactors or standaloneActors
        let gitRepoUrl = `${repoUrl}#${branch}`;
        if (folder) {
            gitRepoUrl = `${gitRepoUrl}:${folder}`;
        }
        buildConfigs.push({ actorName, gitRepoUrl, versionNumber, buildTag, useDockerCache });
    }

    if (dryRun) {
        return buildConfigs;
    }
    console.error('=========================================');
    console.error('STARTED BUILDS:');
    const startedBuilds = await Promise.all(
        buildConfigs.map(async (buildConfig) => {
            const builder = ApifyBuilder.fromActorName(buildConfig.actorName);
            const buildData = await builder.startActorBuild(buildConfig);
            return buildData;
        }),
    );
    console.error('=========================================');
    console.error('FINISHED BUILDS:');
    await Promise.all(
        startedBuilds.map(async (buildData) => {
            const builder = ApifyBuilder.fromActorName(buildData.actorName);
            await builder.waitForBuildToFinish(buildData.buildId, buildData.actorName);
        }),
    );
    console.error('=========================================');
    console.error('SUMMARY:');
    for (const buildData of startedBuilds.sort((a, b) => a.actorName.localeCompare(b.actorName))) {
        console.error(`[${buildData.actorName}]: ${buildData.buildNumber} `);
    }
    console.error('=========================================');

    return startedBuilds;
};

export const deleteOldBuilds = async (actorConfigs: ActorConfig[]) => {
    for (const { actorName } of actorConfigs) {
        await ApifyBuilder.fromActorName(actorName).deleteOldBuilds();
    }
};

export const runZipBuilds = async ({
    actorConfigs,
    dryRun,
}: {
    actorConfigs: ActorConfig[];
    dryRun: boolean;
}): Promise<BuildData[]> => {
    if (dryRun) {
        console.error('[DRY RUN] Would build from local source:');
        for (const { actorName, folder } of actorConfigs) {
            console.error(`  ${actorName} (${folder})`);
        }
        return actorConfigs.map(({ actorName }) => ({
            buildId: 'dry-run',
            actorId: 'dry-run',
            buildNumber: '0.98.0',
            actorName,
        }));
    }

    console.error('=========================================');
    console.error('STARTED ZIP BUILDS:');
    const startedBuilds = await Promise.all(
        actorConfigs.map(async ({ actorName, folder }) => {
            const builder = ApifyBuilder.fromActorName(actorName);
            const sourceFiles = await builder.collectSourceFiles(folder);
            return builder.startActorBuildFromSourceFiles(sourceFiles);
        }),
    );

    console.error('=========================================');
    console.error('FINISHED ZIP BUILDS:');
    await Promise.all(
        startedBuilds.map(async (buildData: BuildData) => {
            const builder = ApifyBuilder.fromActorName(buildData.actorName);
            await builder.waitForBuildToFinish(buildData.buildId, buildData.actorName);
        }),
    );

    console.error('=========================================');
    console.error('SUMMARY:');
    for (const buildData of startedBuilds.sort((a: BuildData, b: BuildData) =>
        a.actorName.localeCompare(b.actorName),
    )) {
        console.error(`[${buildData.actorName}]: ${buildData.buildNumber}`);
    }
    console.error('=========================================');

    return startedBuilds;
};
