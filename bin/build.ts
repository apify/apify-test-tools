import type { Build } from 'apify-client';
import { ApifyClient } from 'apify-client';

import { ACTOR_SOURCE_TYPES } from '@apify/consts';

import type { ActorConfig, BuildData } from './types.js';

type BuildPrActorOptions = {
    buildTag?: string;
    versionNumber: string;
    gitRepoUrl: string;
    actorConfig: ActorConfig;
    useDockerCache: boolean;
};
class ApifyBuilder {
    private constructor(
        private readonly apifyClient: ApifyClient,
        private readonly actorFullName: string,
    ) {}

    // Usually 'latest' but not necessarily (can be e.g. 'version-0')
    getDefaultVersionAndTag = async (): Promise<{
        defaultBuildNumber: string;
        defaultVersionNumber: string;
        defaultBuildTag: string;
    }> => {
        const actorClient = this.apifyClient.actor(this.actorFullName);
        const actorInfo = await actorClient.get();

        if (!actorInfo) {
            throw new Error(
                `[${this.actorFullName}] not found. It is not published or we are missing token to access it privately or its name is misspelled`,
            );
        }

        const defaultBuildTag = actorInfo.defaultRunOptions.build;
        console.error(`Default build tag for ${this.actorFullName} is ${defaultBuildTag}`);

        // We could technically allow this but in most cases this is accidentally set wrongly and there is a workaround
        if (defaultBuildTag.match(/\d+\.\d+\.\d+/)) {
            throw new Error(
                `[${this.actorFullName}] Default build is a build number, not a tag. While this could work, ` +
                    `we want to have a default as tag so this is often an accidental misconfiguration from the dev`,
            );
        }
        // I reported that buildNumber should probably not be optional
        const defaultBuildNumber = actorInfo.taggedBuilds![defaultBuildTag].buildNumber!;
        const defaultVersionNumber = defaultBuildNumber.match(/(\d+\.\d+)\.\d+/)![1];
        console.error(`Default version for ${this.actorFullName} is ${defaultVersionNumber}`);

        return { defaultBuildNumber, defaultVersionNumber, defaultBuildTag };
    };

    startActorBuild = async ({
        buildTag,
        versionNumber,
        gitRepoUrl,
        useDockerCache,
    }: BuildPrActorOptions): Promise<BuildData> => {
        const actorClient = this.apifyClient.actor(this.actorFullName);
        const actorInfo = await actorClient.get();
        if (!actorInfo) {
            throw new Error(
                `No actor named '${this.actorFullName}' was found on the platform. If this` +
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

        console.error(`[${this.actorFullName}]: ${id} (${buildNumber})`);
        return { buildId: id, actorRawId: actId, buildNumber, actorFullName: this.actorFullName };
    };

    waitForBuildToFinish = async (buildId: string): Promise<Build> => {
        const build = await this.apifyClient.build(buildId).waitForFinish();
        const versionNumber = build.buildNumber;
        if (build.status === 'FAILED' || build.status === 'TIMED-OUT') {
            const message =
                `[BUILD][${this.actorFullName}]: Build ${buildId} (${versionNumber}) failed. ` +
                `Not continuing with other builds and tests.`;
            console.error(`[${this.actorFullName}]: ${versionNumber}`);
            throw new Error(message);
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

        const actorInfo = (await this.apifyClient.actor(this.actorFullName).get())!;

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
        const { defaultBuildNumber, defaultBuildTag } = await this.getDefaultVersionAndTag();

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

    for (const actorConfig of actorConfigs) {
        let versionNumber: string;
        let buildTag: string | undefined;

        if (isLatest) {
            const { defaultVersionNumber, defaultBuildTag } =
                await ApifyBuilder.fromActorConfig(actorConfig).getDefaultVersionAndTag();
            versionNumber = defaultVersionNumber;
            buildTag = defaultBuildTag;
        } else {
            versionNumber = '0.99';
        }

        // Depending on if these are miniactors or standaloneActors
        let gitRepoUrl = `${repoUrl}#${branch}`;
        if (actorConfig.folder) {
            gitRepoUrl = `${gitRepoUrl}:${actorConfig.folder}`;
        }
        buildConfigs.push({ actorConfig, gitRepoUrl, versionNumber, buildTag, useDockerCache });
    }

    if (dryRun) {
        return buildConfigs;
    }

    const buildersByActorFullName = new Map<string, ApifyBuilder>(
        actorConfigs.map((actorConfig) => [actorConfig.actorFullName, ApifyBuilder.fromActorConfig(actorConfig)]),
    );
    console.error('=========================================');
    console.error('STARTED BUILDS:');
    const startedBuilds = await Promise.all(
        buildConfigs.map(async (buildConfig) => {
            const builder = buildersByActorFullName.get(buildConfig.actorConfig.actorFullName)!;
            const buildData = await builder.startActorBuild(buildConfig);
            return buildData;
        }),
    );
    console.error('=========================================');
    console.error('FINISHED BUILDS:');
    await Promise.all(
        startedBuilds.map(async (buildData) => {
            const builder = buildersByActorFullName.get(buildData.actorFullName)!;
            await builder.waitForBuildToFinish(buildData.buildId);
        }),
    );
    console.error('=========================================');
    console.error('SUMMARY:');
    for (const buildData of startedBuilds.sort((a, b) => a.actorFullName.localeCompare(b.actorFullName))) {
        console.error(`[${buildData.actorFullName}]: ${buildData.buildNumber} `);
    }
    console.error('=========================================');

    return startedBuilds;
};

export const deleteOldBuilds = async (actorConfigs: ActorConfig[]) => {
    for (const actorConfig of actorConfigs) {
        await ApifyBuilder.fromActorConfig(actorConfig).deleteOldBuilds();
    }
};
