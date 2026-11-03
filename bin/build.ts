import type * as ApifyClientTypes from 'apify-client';
import { ActorSourceType, ApifyClient } from 'apify-client';

import { getCurrentBranch, normalizeRepoUrl, resolveRepoUrl } from './git.js';
import { logger } from './logger.js';
import type { ActorConfig, BuildData, DryRunPlan } from './types.js';

type BuildPrActorOptions = {
    versionNumber: string;
    gitRepoUrl: string;
    actorConfig: ActorConfig;
    actorInfo: ApifyClientTypes.Actor;
};

// Fixed version number used to build from local source files, since there is no real version to track.
export const LOCAL_SOURCE_VERSION_NUMBER = '0.98';
// Stands for each Actor's default version: the one its default build tag points to
export const DEFAULT_VERSION_KEYWORD = 'default';

// Shown whenever an Actor isn't set up the way CI builds need it
const ACTOR_SETUP_REQUIREMENT =
    'Before using apify-test-tools, every Actor needs at least one build under its default build tag (usually "latest"), ' +
    'built from a Git repository version whose URL points to this repository. Build it once manually on the platform.';

/**
 * Finds the Actor's default version: the one whose build the default build tag points to.
 * Usually tagged 'latest' but not necessarily (can be e.g. 'version-0').
 */
export const resolveDefaultVersion = (actorFullName: string, actorInfo: ApifyClientTypes.Actor) => {
    const defaultBuildTag = actorInfo.defaultRunOptions.build;
    logger.info(`Default build tag for ${actorFullName} is ${defaultBuildTag}`);

    // We could technically allow this but in most cases this is accidentally set wrongly and there is a workaround
    if (defaultBuildTag.match(/\d+\.\d+\.\d+/)) {
        throw new Error(
            `[${actorFullName}] Default build is a build number, not a tag. While this could work, ` +
                `we want to have a default as tag so this is often an accidental misconfiguration from the dev`,
        );
    }
    // I reported that buildNumber should probably not be optional
    const defaultBuildNumber = actorInfo.taggedBuilds?.[defaultBuildTag]?.buildNumber;
    if (!defaultBuildNumber) {
        throw new Error(`[${actorFullName}] No build found for tag "${defaultBuildTag}". ${ACTOR_SETUP_REQUIREMENT}`);
    }
    const defaultVersionNumber = defaultBuildNumber.match(/(\d+\.\d+)\.\d+/)![1];
    logger.info(`Default version for ${actorFullName} is ${defaultVersionNumber}`);

    const defaultVersion = actorInfo.versions.find((version) => version.versionNumber === defaultVersionNumber);

    return { defaultBuildNumber, defaultVersionNumber, defaultBuildTag, defaultVersion };
};

/**
 * Guards against building an Actor from a different repository than it is published from, e.g. when the
 * local `origin` remote is a fork or a mirror. Every build overwrites the version's Git URL, so building
 * from the wrong remote would silently repoint the Actor. The default version is the source of truth
 * since it is what users run. Skipped when the repo URL is passed explicitly, which is how you move an
 * Actor to a new repository on purpose.
 */
export const assertRepoUrlMatchesDefaultVersion = (
    actorFullName: string,
    defaultVersion: ApifyClientTypes.ActorVersion | undefined,
    repoUrl: string,
) => {
    if (!defaultVersion) {
        throw new Error(
            `[${actorFullName}] The version of the default build no longer exists. ${ACTOR_SETUP_REQUIREMENT}`,
        );
    }
    if (defaultVersion.sourceType !== ActorSourceType.GitRepo) {
        throw new Error(
            `[${actorFullName}] Default version ${defaultVersion.versionNumber} has source type "${defaultVersion.sourceType}", ` +
                `not "${ActorSourceType.GitRepo}". ${ACTOR_SETUP_REQUIREMENT}`,
        );
    }
    if (normalizeRepoUrl(defaultVersion.gitRepoUrl) !== normalizeRepoUrl(repoUrl)) {
        throw new Error(
            `[${actorFullName}] Repository mismatch: the git remote "origin" is ${repoUrl} but default version ` +
                `${defaultVersion.versionNumber} is built from ${defaultVersion.gitRepoUrl}. Fix the remote or the Actor's source, ` +
                `or pass --repo-url to build from a different repository on purpose.`,
        );
    }
};

const getEnvVarNames = (version: ApifyClientTypes.ActorVersion | undefined): string[] =>
    (version?.envVars ?? []).map(({ name }) => name).filter((name): name is string => !!name);

/**
 * Guards against testing an Actor with different env vars than users run it with, e.g. a variable added to
 * the default version but not to the test version, which would make the tests pass or fail for the wrong
 * reason. Only names are compared because the API doesn't return secret values.
 */
export const assertEnvVarsMatchDefaultVersion = (
    actorFullName: string,
    actorInfo: ApifyClientTypes.Actor,
    defaultVersion: ApifyClientTypes.ActorVersion | undefined,
    versionNumber: string,
) => {
    if (!defaultVersion) {
        throw new Error(
            `[${actorFullName}] The version of the default build no longer exists. ${ACTOR_SETUP_REQUIREMENT}`,
        );
    }
    const version = actorInfo.versions.find((v) => v.versionNumber === versionNumber);
    const defaultNames = getEnvVarNames(defaultVersion);
    const names = getEnvVarNames(version);
    const missing = defaultNames.filter((name) => !names.includes(name));
    const extra = names.filter((name) => !defaultNames.includes(name));
    if (missing.length === 0 && extra.length === 0) return;

    const differences = [
        missing.length > 0 ? `missing ${missing.join(', ')}` : undefined,
        extra.length > 0 ? `extra ${extra.join(', ')}` : undefined,
    ].filter(Boolean);
    throw new Error(
        `[${actorFullName}] Env vars of version ${versionNumber} are out of sync with default version ` +
            `${defaultVersion.versionNumber} (${differences.join('; ')}). ` +
            `${version ? '' : `Version ${versionNumber} doesn't exist yet, so create it on the platform first. `}` +
            `Add or remove the env vars in version ${versionNumber} so their names match the default version's.`,
    );
};

export class ApifyBuilder {
    private constructor(
        private readonly apifyClient: ApifyClient,
        private readonly actorFullName: string,
    ) {}

    getActorInfo = async (): Promise<ApifyClientTypes.Actor> => {
        const actorInfo = await this.apifyClient.actor(this.actorFullName).get();
        if (!actorInfo) {
            throw new Error(
                `[${this.actorFullName}] not found. It is not published or we are missing token to access it privately or its name is misspelled`,
            );
        }
        return actorInfo;
    };

    getDefaultVersionAndTag = async () => resolveDefaultVersion(this.actorFullName, await this.getActorInfo());

    // Mirrors `apify push`: stores the zip in the Actor's `actor-<id>-source` KV store and returns a signed
    // record URL the builder can download without a token.
    uploadSourceZip = async (versionNumber: string, zip: Buffer): Promise<string> => {
        const actorInfo = await this.apifyClient.actor(this.actorFullName).get();
        if (!actorInfo) throw new Error(`No actor named '${this.actorFullName}' was found on the platform.`);

        const store = await this.apifyClient.keyValueStores().getOrCreate(`actor-${actorInfo.id}-source`);
        const storeClient = this.apifyClient.keyValueStore(store.id);
        const key = `version-${versionNumber}.zip`;
        await storeClient.setRecord({ key, value: zip as never, contentType: 'application/zip' });

        const url = new URL(await storeClient.getRecordPublicUrl(key));
        url.searchParams.set('disableRedirect', 'true');
        return url.toString();
    };

    // Pass actorInfo when the caller already fetched it, to save an API call
    createVersionAndBuild = async (
        versionNumber: string,
        actorVersion: ApifyClientTypes.ActorVersion,
        useCache: boolean,
        actorInfo?: ApifyClientTypes.Actor,
    ): Promise<BuildData> => {
        const actorClient = this.apifyClient.actor(this.actorFullName);
        const { versions } = actorInfo ?? (await this.getActorInfo());

        // Prepare version
        const versionMissing = !versions.find((version) => version.versionNumber === versionNumber);
        if (versionMissing) {
            // create new version
            await actorClient.versions().create(actorVersion);
        } else {
            const version = actorClient.version(versionNumber);
            await version.update(actorVersion);
        }

        // We also get back actId so the testing actor can both match by actor ID and name
        const { id, actId, buildNumber } = await actorClient.build(versionNumber, { useCache });

        logger.info(`[${this.actorFullName}]: ${id} (${buildNumber})`);
        return { buildId: id, actorRawId: actId, buildNumber, actorFullName: this.actorFullName };
    };

    waitForBuildToFinish = async (buildId: string): Promise<ApifyClientTypes.Build> => {
        const build = await this.apifyClient.build(buildId).waitForFinish();
        const versionNumber = build.buildNumber;
        if (build.status === 'FAILED' || build.status === 'TIMED-OUT') {
            logger.error(`[${this.actorFullName}]: ${versionNumber}`);
            try {
                const log = await this.apifyClient.build(buildId).log().get();
                const logTail = log?.split('\n').slice(-40).join('\n');
                logger.error(`\n--- BUILD LOG (last 40 lines) ---\n${logTail}\n---`);
            } catch (err) {
                logger.error(`[${this.actorFullName}]: Failed to fetch build log: ${err}`);
            }
            throw new Error(
                `[BUILD][${this.actorFullName}]: Build ${buildId} (${versionNumber}) failed. ` +
                    `Not continuing with other builds and tests.`,
            );
        }
        logger.info(`[${this.actorFullName}]: ${versionNumber}`);
        return build;
    };

    static fromActorConfig = (actorConfig: ActorConfig): ApifyBuilder => {
        const { actorFullName, tokenEnvVar } = actorConfig;
        const token = process.env[tokenEnvVar];
        if (!token) {
            throw new Error(`Env var ${tokenEnvVar} is not set (needed for actor "${actorFullName}").`);
        }
        const apifyClient = new ApifyClient({ token });
        return new ApifyBuilder(apifyClient, actorFullName);
    };

    /**
     * Deletes build of all versions. Apify API doesn't allow to delete default build and we explicitly skip it
     * We delete devel builds faster because we used the for every PR until recently so just to get rid of them faster
     */
    async deleteOldBuilds({ dryRun }: { dryRun: boolean }): Promise<void> {
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

        const actorInfo = await this.getActorInfo();

        // 'devel' used to be hardcoded for testing version 0.99, once we get rid of this tag everywhere, we can remove this code
        const taggedDevelBuildNumber: string | undefined = actorInfo.taggedBuilds!.devel?.buildNumber;

        const allTags = Object.keys(actorInfo.taggedBuilds ?? {});
        const protectedTags = allTags.filter((tag) => PROTECTED_TAGS_PREFIX.some((prefix) => tag.startsWith(prefix)));
        const protectedBuildNumbers = protectedTags.map((tag) => ({
            buildNumber: actorInfo.taggedBuilds![tag]!.buildNumber,
            tag,
        }));

        const { items } = await this.apifyClient.actor(this.actorFullName).builds().list();

        // Deleting default build throws an error, so we skip it
        const { defaultBuildNumber, defaultBuildTag } = resolveDefaultVersion(this.actorFullName, actorInfo);

        const daysAgoUnixProd = Date.now() - DEFAULT_DAYS_BACK_PROD_VERSIONS * 24 * 60 * 60 * 1000;
        const daysAgoUnixDevel = Date.now() - DEFAULT_DAYS_BACK_DEVEL * 24 * 60 * 60 * 1000;

        // Fixing API client missing buildNumber field
        type CorrectBuildColletionItem = (typeof items)[0] & { buildNumber: string };
        const buildsToDelete = (items as CorrectBuildColletionItem[]).filter((build) => {
            if (build.buildNumber === defaultBuildNumber) {
                logger.info(
                    `[DELETE OLD BUILDS][${this.actorFullName}]: Skipping default build ${defaultBuildNumber} (${defaultBuildTag}). ` +
                        `We never delete default builds`,
                );
                return false;
            }

            const protectedTagFound = protectedBuildNumbers.find(
                (protectedBuildNumber) => protectedBuildNumber.buildNumber === build.buildNumber,
            );
            if (protectedTagFound) {
                logger.info(
                    `[DELETE OLD BUILDS][${this.actorFullName}]: Skipping protected build ${protectedTagFound.buildNumber} (${protectedTagFound.tag}).`,
                );
                return false;
            }

            if (taggedDevelBuildNumber && build.buildNumber === taggedDevelBuildNumber) {
                const shouldDeleteDevelBuild = build.startedAt.getTime() < daysAgoUnixDevel;
                if (shouldDeleteDevelBuild) {
                    logger.info(
                        `[DELETE OLD BUILDS][${this.actorFullName}]: Removing olf devel build ${taggedDevelBuildNumber}.`,
                    );
                }
                return shouldDeleteDevelBuild;
            }
            return build.startedAt.getTime() < daysAgoUnixProd;
        });

        logger.info(
            `[DELETE OLD BUILDS][${this.actorFullName}]: ${dryRun ? '[DRY RUN] Would delete' : 'Deleting'} ${buildsToDelete.length} ` +
                `old builds that are non-default and older than 30 days from total ${items.length}`,
        );
        if (dryRun) {
            for (const build of buildsToDelete) {
                logger.info(`  ${build.buildNumber} (${build.id}, started ${build.startedAt.toISOString()})`);
            }
            return;
        }
        for (const build of buildsToDelete) {
            await this.apifyClient.build(build.id).delete();
        }
    }
}

export const waitAndSummarizeBuilds = async (
    startedBuilds: BuildData[],
    buildersMap: Map<string, ApifyBuilder>,
    label: string,
): Promise<BuildData[]> => {
    logger.info('=========================================');
    logger.info(`FINISHED ${label}:`);
    await Promise.all(
        startedBuilds.map(async (buildData) => {
            const builder = buildersMap.get(buildData.actorFullName)!;
            await builder.waitForBuildToFinish(buildData.buildId);
        }),
    );

    logger.info('=========================================');
    logger.info('SUMMARY:');
    for (const buildData of startedBuilds.sort((a, b) => a.actorFullName.localeCompare(b.actorFullName))) {
        logger.info(`[${buildData.actorFullName}]: ${buildData.buildNumber}`);
    }
    logger.info('=========================================');

    return startedBuilds;
};

export const runAndSummarizeBuilds = async (
    actorConfigs: ActorConfig[],
    label: string,
    buildOneActor: (actorConfig: ActorConfig, builder: ApifyBuilder) => Promise<BuildData>,
): Promise<BuildData[]> => {
    const buildersByActorFullName = new Map<string, ApifyBuilder>(
        actorConfigs.map((actorConfig) => [actorConfig.actorFullName, ApifyBuilder.fromActorConfig(actorConfig)]),
    );
    logger.info('=========================================');
    logger.info(`STARTED ${label}:`);
    const startedBuilds = await Promise.all(
        actorConfigs.map(async (actorConfig) =>
            buildOneActor(actorConfig, buildersByActorFullName.get(actorConfig.actorFullName)!),
        ),
    );

    return waitAndSummarizeBuilds(startedBuilds, buildersByActorFullName, label);
};

type GitBuildPlan = {
    actorFullName: string;
    versionNumber: string;
    gitRepoUrl: string;
};

type RunBuildsOptions = {
    actorConfigs: ActorConfig[];
    // A version number like "0.99", or DEFAULT_VERSION_KEYWORD for each Actor's default version
    versionNumber: string;
    repoUrl: string;
    // False when the repo URL was passed explicitly, see assertRepoUrlMatchesDefaultVersion
    shouldVerifyRepoUrl: boolean;
    branch: string;
    dryRun: boolean;
    // See assertEnvVarsMatchDefaultVersion
    requireEnvVarsInSync?: boolean;
};

export const runBuilds = async ({
    repoUrl,
    shouldVerifyRepoUrl,
    branch,
    actorConfigs,
    versionNumber,
    dryRun,
    requireEnvVarsInSync = false,
}: RunBuildsOptions): Promise<BuildData[] | DryRunPlan<GitBuildPlan>> => {
    // Fetched once per Actor and reused for the checks, the version numbers and the build itself
    const buildConfigs: BuildPrActorOptions[] = await Promise.all(
        actorConfigs.map(async (actorConfig) => {
            const actorInfo = await ApifyBuilder.fromActorConfig(actorConfig).getActorInfo();
            const { defaultVersionNumber, defaultBuildTag, defaultVersion } = resolveDefaultVersion(
                actorConfig.actorFullName,
                actorInfo,
            );
            // Builds keep the tags their version gives them, so a default version without the default build tag
            // would build fine but leave users on the previous build
            if (versionNumber === DEFAULT_VERSION_KEYWORD && defaultVersion?.buildTag !== defaultBuildTag) {
                logger.warn(
                    `[${actorConfig.actorFullName}] Default version ${defaultVersionNumber} has build tag ` +
                        `"${defaultVersion?.buildTag ?? 'none'}", not "${defaultBuildTag}", so users keep running the previous build. ` +
                        'Set the build tag of the version on the platform to change that.',
                );
            }
            if (shouldVerifyRepoUrl) {
                assertRepoUrlMatchesDefaultVersion(actorConfig.actorFullName, defaultVersion, repoUrl);
            }
            const targetVersionNumber =
                versionNumber === DEFAULT_VERSION_KEYWORD ? defaultVersionNumber : versionNumber;
            if (requireEnvVarsInSync) {
                assertEnvVarsMatchDefaultVersion(
                    actorConfig.actorFullName,
                    actorInfo,
                    defaultVersion,
                    targetVersionNumber,
                );
            }

            // Depending on if these are miniactors or standaloneActors
            let gitRepoUrl = `${repoUrl}#${branch}`;
            if (!actorConfig.folder.isRoot()) {
                gitRepoUrl = `${gitRepoUrl}:${actorConfig.folder}`;
            }
            return {
                actorConfig,
                actorInfo,
                gitRepoUrl,
                versionNumber: targetVersionNumber,
            };
        }),
    );

    // Everything above only reads, so a dry run has checked what the real run would, short of writing
    if (dryRun) {
        logger.info('[DRY RUN] Would build:');
        const builds = buildConfigs.map((buildConfig) => ({
            actorFullName: buildConfig.actorConfig.actorFullName,
            versionNumber: buildConfig.versionNumber,
            gitRepoUrl: buildConfig.gitRepoUrl,
        }));
        for (const build of builds) {
            logger.info(`  ${build.actorFullName} (${build.versionNumber}) from ${build.gitRepoUrl}`);
        }
        return { dryRun: true, builds };
    }

    const buildConfigsByActorFullName = new Map(
        buildConfigs.map((buildConfig) => [buildConfig.actorConfig.actorFullName, buildConfig]),
    );

    return runAndSummarizeBuilds(actorConfigs, 'BUILDS', async (actorConfig, builder) => {
        const buildConfig = buildConfigsByActorFullName.get(actorConfig.actorFullName)!;
        // No buildTag: the version keeps the one it has, so its build gets the tag the version already gives it
        const actorVersion: ApifyClientTypes.ActorVersion = {
            versionNumber: buildConfig.versionNumber,
            gitRepoUrl: buildConfig.gitRepoUrl,
            sourceType: ActorSourceType.GitRepo,
        };
        // Always with the Docker cache: CI always asked for it, and a clean build can still be started on the platform
        return builder.createVersionAndBuild(buildConfig.versionNumber, actorVersion, true, buildConfig.actorInfo);
    });
};

type BuildActorsOptions = Omit<RunBuildsOptions, 'repoUrl' | 'shouldVerifyRepoUrl' | 'branch'> & {
    // Defaults to the `origin` remote, see resolveRepoUrl
    repoUrl?: string;
};

/**
 * Builds exactly the given Actors from the checked-out Git branch, as it is on the remote. Fails on a detached HEAD,
 * where there is no branch to build. Used by `build` and the commands built on top of it.
 */
export const buildActors = async ({ actorConfigs, repoUrl, ...options }: BuildActorsOptions) => {
    if (actorConfigs.length === 0) {
        logger.info('No Actors to build');
        // Still the dry-run shape in a dry run, so it can't pass for a real (empty) result
        return options.dryRun ? { dryRun: true as const, builds: [] } : [];
    }
    return runBuilds({
        ...options,
        ...(await resolveRepoUrl(repoUrl)),
        actorConfigs,
        branch: await getCurrentBranch(),
    });
};

export const deleteOldBuilds = async (actorConfigs: ActorConfig[], { dryRun }: { dryRun: boolean }) => {
    for (const actorConfig of actorConfigs) {
        await ApifyBuilder.fromActorConfig(actorConfig).deleteOldBuilds({ dryRun });
    }
};
