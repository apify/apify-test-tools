import type { Actor, ActorVersion, Build } from 'apify-client';
import { ActorSourceType, ApifyClient } from 'apify-client';

import { normalizeRepoUrl } from './git.js';
import type { ActorConfig, BuildData } from './types.js';

type BuildPrActorOptions = {
    buildTag?: string;
    versionNumber: string;
    gitRepoUrl: string;
    actorConfig: ActorConfig;
    actorInfo: Actor;
    useDockerCache: boolean;
};

// Fixed version number used to build from local source files, since there is no real version to track.
export const LOCAL_SOURCE_VERSION_NUMBER = '0.98';
const DEFAULT_TEST_VERSION_NUMBER = '0.99';

// Shown whenever an Actor isn't set up the way CI builds need it
const ACTOR_SETUP_REQUIREMENT =
    'Before using apify-test-tools, every Actor needs at least one build under its default build tag (usually "latest"), ' +
    'built from a Git repository version whose URL points to this repository. Build it once manually on the platform.';

/**
 * Finds the Actor's default version: the one whose build the default build tag points to.
 * Usually tagged 'latest' but not necessarily (can be e.g. 'version-0').
 */
export const resolveDefaultVersion = (actorFullName: string, actorInfo: Actor) => {
    const defaultBuildTag = actorInfo.defaultRunOptions.build;
    console.error(`Default build tag for ${actorFullName} is ${defaultBuildTag}`);

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
    console.error(`Default version for ${actorFullName} is ${defaultVersionNumber}`);

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
    defaultVersion: ActorVersion | undefined,
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

export class ApifyBuilder {
    private constructor(
        private readonly apifyClient: ApifyClient,
        private readonly actorFullName: string,
    ) {}

    getActorInfo = async (): Promise<Actor> => {
        const actorInfo = await this.apifyClient.actor(this.actorFullName).get();
        if (!actorInfo) {
            throw new Error(
                `[${this.actorFullName}] not found. It is not published or we are missing token to access it privately or its name is misspelled`,
            );
        }
        return actorInfo;
    };

    getDefaultVersionAndTag = async () => resolveDefaultVersion(this.actorFullName, await this.getActorInfo());

    // Pass actorInfo when the caller already fetched it, to save an API call
    createVersionAndBuild = async (
        versionNumber: string,
        actorVersion: ActorVersion,
        useCache: boolean,
        actorInfo?: Actor,
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

        console.error(`[${this.actorFullName}]: ${id} (${buildNumber})`);
        return { buildId: id, actorRawId: actId, buildNumber, actorFullName: this.actorFullName };
    };

    waitForBuildToFinish = async (buildId: string): Promise<Build> => {
        const build = await this.apifyClient.build(buildId).waitForFinish();
        const versionNumber = build.buildNumber;
        if (build.status === 'FAILED' || build.status === 'TIMED-OUT') {
            console.error(`[${this.actorFullName}]: ${versionNumber}`);
            try {
                const log = await this.apifyClient.build(buildId).log().get();
                const logTail = log?.split('\n').slice(-40).join('\n');
                console.error(`\n--- BUILD LOG (last 40 lines) ---\n${logTail}\n---`);
            } catch (err) {
                console.error(`[${this.actorFullName}]: Failed to fetch build log: ${err}`);
            }
            throw new Error(
                `[BUILD][${this.actorFullName}]: Build ${buildId} (${versionNumber}) failed. ` +
                    `Not continuing with other builds and tests.`,
            );
        }
        console.error(`[${this.actorFullName}]: ${versionNumber}`);
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
                console.error(
                    `[DELETE OLD BUILDS][${this.actorFullName}]: Skipping default build ${defaultBuildNumber} (${defaultBuildTag}). ` +
                        `We never delete default builds`,
                );
                return false;
            }

            const protectedTagFound = protectedBuildNumbers.find(
                (protectedBuildNumber) => protectedBuildNumber.buildNumber === build.buildNumber,
            );
            if (protectedTagFound) {
                console.error(
                    `[DELETE OLD BUILDS][${this.actorFullName}]: Skipping protected build ${protectedTagFound.buildNumber} (${protectedTagFound.tag}).`,
                );
                return false;
            }

            if (taggedDevelBuildNumber && build.buildNumber === taggedDevelBuildNumber) {
                const shouldDeleteDevelBuild = build.startedAt.getTime() < daysAgoUnixDevel;
                if (shouldDeleteDevelBuild) {
                    console.error(
                        `[DELETE OLD BUILDS][${this.actorFullName}]: Removing olf devel build ${taggedDevelBuildNumber}.`,
                    );
                }
                return shouldDeleteDevelBuild;
            }
            return build.startedAt.getTime() < daysAgoUnixProd;
        });

        console.error(
            `[DELETE OLD BUILDS][${this.actorFullName}]: Deleting ${buildsToDelete.length} old builds that are non-default and ` +
                `older than 30 days from total ${items.length}`,
        );
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
    console.error('=========================================');
    console.error(`FINISHED ${label}:`);
    await Promise.all(
        startedBuilds.map(async (buildData) => {
            const builder = buildersMap.get(buildData.actorFullName)!;
            await builder.waitForBuildToFinish(buildData.buildId);
        }),
    );

    console.error('=========================================');
    console.error('SUMMARY:');
    for (const buildData of startedBuilds.sort((a, b) => a.actorFullName.localeCompare(b.actorFullName))) {
        console.error(`[${buildData.actorFullName}]: ${buildData.buildNumber}`);
    }
    console.error('=========================================');

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
    console.error('=========================================');
    console.error(`STARTED ${label}:`);
    const startedBuilds = await Promise.all(
        actorConfigs.map(async (actorConfig) =>
            buildOneActor(actorConfig, buildersByActorFullName.get(actorConfig.actorFullName)!),
        ),
    );

    return waitAndSummarizeBuilds(startedBuilds, buildersByActorFullName, label);
};

// Placeholder BuildData for dry runs, since no real build was triggered.
export const dryRunBuildData = (actorFullName: string, versionNumber: string): BuildData => ({
    buildId: 'dry-run',
    actorRawId: 'dry-run',
    buildNumber: versionNumber,
    actorFullName,
});

type RunBuildsOptions = {
    actorConfigs: ActorConfig[];
    isLatest?: boolean;
    repoUrl: string;
    // False when the repo URL was passed explicitly, see assertRepoUrlMatchesDefaultVersion
    verifyRepoUrl: boolean;
    branch: string;
    dryRun: boolean;
    useDockerCache: boolean;
};

export const runBuilds = async ({
    repoUrl,
    verifyRepoUrl,
    branch,
    actorConfigs,
    isLatest = false,
    dryRun,
    useDockerCache,
}: RunBuildsOptions): Promise<BuildData[]> => {
    // Fetched once per Actor and reused for the checks, the version numbers and the build itself
    const buildConfigs: BuildPrActorOptions[] = await Promise.all(
        actorConfigs.map(async (actorConfig) => {
            const actorInfo = await ApifyBuilder.fromActorConfig(actorConfig).getActorInfo();
            const { defaultVersionNumber, defaultBuildTag, defaultVersion } = resolveDefaultVersion(
                actorConfig.actorFullName,
                actorInfo,
            );
            if (verifyRepoUrl) {
                assertRepoUrlMatchesDefaultVersion(actorConfig.actorFullName, defaultVersion, repoUrl);
            }

            // Depending on if these are miniactors or standaloneActors
            let gitRepoUrl = `${repoUrl}#${branch}`;
            if (actorConfig.folder) {
                gitRepoUrl = `${gitRepoUrl}:${actorConfig.folder}`;
            }
            return {
                actorConfig,
                actorInfo,
                gitRepoUrl,
                versionNumber: isLatest ? defaultVersionNumber : DEFAULT_TEST_VERSION_NUMBER,
                buildTag: isLatest ? defaultBuildTag : undefined,
                useDockerCache,
            };
        }),
    );

    if (dryRun) {
        console.error('[DRY RUN] Would build:');
        for (const { actorConfig, versionNumber } of buildConfigs) {
            console.error(`  ${actorConfig.actorFullName} (${versionNumber})`);
        }
        return buildConfigs.map(({ actorConfig, versionNumber }) =>
            dryRunBuildData(actorConfig.actorFullName, versionNumber),
        );
    }

    const buildConfigsByActorFullName = new Map(
        buildConfigs.map((buildConfig) => [buildConfig.actorConfig.actorFullName, buildConfig]),
    );

    return runAndSummarizeBuilds(actorConfigs, 'BUILDS', async (actorConfig, builder) => {
        const {
            actorInfo,
            buildTag,
            versionNumber,
            gitRepoUrl,
            useDockerCache: useCache,
        } = buildConfigsByActorFullName.get(actorConfig.actorFullName)!;
        const actorVersion: ActorVersion = {
            buildTag,
            versionNumber,
            gitRepoUrl,
            sourceType: ActorSourceType.GitRepo,
        };
        return builder.createVersionAndBuild(versionNumber, actorVersion, useCache, actorInfo);
    });
};

export const deleteOldBuilds = async (actorConfigs: ActorConfig[]) => {
    for (const actorConfig of actorConfigs) {
        await ApifyBuilder.fromActorConfig(actorConfig).deleteOldBuilds();
    }
};
