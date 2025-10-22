import { ACTOR_SOURCE_TYPES } from '@apify/consts';
import { ApifyClient, Build } from 'apify-client';
import type { ActorConfig, BuildData } from './types.js';
import { getEnvVar } from './utils.js';

type BuildPrActorOptions = {
    buildTag?: string
    versionNumber: string
    gitRepoUrl: string
    actorName: string
}
class ApifyBuilder {
    // eslint-disable-next-line no-empty-function
    private constructor(private readonly apifyClient: ApifyClient, private readonly actorName: string) { }

    // Usually 'latest' but not necessarily (can be e.g. 'version-0')
    getDefaultVersionAndTag = async (): Promise<{ defaultBuildNumber: string, defaultVersionNumber: string, defaultBuildTag: string }> => {
        const actorClient = this.apifyClient.actor(this.actorName);
        const actorInfo = await actorClient.get();

        if (!actorInfo) {
            throw new Error(`[${this.actorName}] not found. It is not published or we are missing token to access it privately or its name is misspelled`);
        }

        const defaultBuildTag = actorInfo.defaultRunOptions.build;
        console.error(`Default build tag for ${this.actorName} is ${defaultBuildTag}`);

        // We could technically allow this but in most cases this is accidentally set wrongly and there is a workaround
        if (defaultBuildTag.match(/\d+\.\d+\.\d+/)) {
            throw new Error(`[${this.actorName}] Default build is a build number, not a tag. While this could work, `
                + `we want to have a default as tag so this is often an accidental misconfiguration from the dev`);
        }
        // I reported that buildNumber should probably not be optional
        const defaultBuildNumber = actorInfo.taggedBuilds![defaultBuildTag].buildNumber!;
        const defaultVersionNumber = defaultBuildNumber.match(/(\d+\.\d+)\.\d+/)![1];
        console.error(`Default version for ${this.actorName} is ${defaultVersionNumber}`);

        return { defaultBuildNumber, defaultVersionNumber, defaultBuildTag };
    };

    startActorBuild = async ({
        buildTag,
        versionNumber,
        gitRepoUrl,
    }: BuildPrActorOptions): Promise<BuildData> => {
        const actorClient = this.apifyClient.actor(this.actorName);
        const actorInfo = await actorClient.get();
        if (!actorInfo) {
            throw new Error(`No actor named '${this.actorName}' was found on the platform. If this`
                + ' is unexpected, make sure the actor you are targeting is spelled the'
                + ' same as the folder in the repository.');
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
        const { id, actId, buildNumber } = await actorClient.build(versionNumber);

        console.error(`[${this.actorName}]: ${id} (${buildNumber})`);
        return { buildId: id, actorId: actId, buildNumber, actorName: this.actorName };
    };

    waitForBuildToFinish = async (buildId: string, actorName: string): Promise<Build> => {
        const build = await this.apifyClient.build(buildId).waitForFinish();
        const versionNumber = build.buildNumber;
        if (build.status === 'FAILED' || build.status === 'TIMED-OUT') {
            const message = `[BUILD][${actorName}]: Build ${buildId} (${versionNumber}) failed. `
                + `Not continuing with other builds and tests.`;
            console.error(`[${this.actorName}]: ${versionNumber}`);
            throw new Error(message);
        }

        // console.error(`[${this.actorName}]: ${versionNumber}`);
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
            throw new Error(`Cannot find Apify API token for username: ${username}. `
                + `Have you set secret env var to this GitHub repo with key: ${usernameEnvVar}?`);
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
        const PROTECTED_TAGS_PREFIX = ['latest', 'v-', 'version', 'v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9'];

        // We don't want to be too short because we might to debug something
        // but also not too long because it increases the risk of users using outdated versions
        const DEFAULT_DAYS_BACK_PROD_VERSIONS = 30;
        const DEFAULT_DAYS_BACK_DEVEL = 7;

        const actorInfo = (await this.apifyClient.actor(this.actorName).get())!;

        // 'devel' used to be hardcoded for testing version 0.99, once we get rid of this tag everywhere, we can remove this code
        const taggedDevelBuildNumber: string | undefined = actorInfo.taggedBuilds!.devel?.buildNumber;

        const allTags = Object.keys(actorInfo.taggedBuilds ?? {});
        const protectedTags = allTags.filter((tag) => PROTECTED_TAGS_PREFIX.some((prefix) => tag.startsWith(prefix)));
        const protectedBuildNumbers = protectedTags.map((tag) => ({ buildNumber: actorInfo.taggedBuilds![tag]!.buildNumber, tag }));

        const { items } = (await this.apifyClient.actor(this.actorName).builds().list());

        // Deleting default build throws an error, so we skip it
        const { defaultBuildNumber, defaultBuildTag } = await ApifyBuilder.fromActorName(this.actorName).getDefaultVersionAndTag();

        const daysAgoUnixProd = Date.now() - DEFAULT_DAYS_BACK_PROD_VERSIONS * 24 * 60 * 60 * 1000;
        const daysAgoUnixDevel = Date.now() - DEFAULT_DAYS_BACK_DEVEL * 24 * 60 * 60 * 1000;

        // Fixing API client missing buildNumber field
        type CorrectBuildColletionItem = typeof items[0] & { buildNumber: string };
        const buildsToDelete = (items as CorrectBuildColletionItem[]).filter((build) => {
            if (build.buildNumber === defaultBuildNumber) {
                console.error(`[DELETE OLD BUILDS][${this.actorName}]: Skipping default build ${defaultBuildNumber} (${defaultBuildTag}). `
                    + `We never delete default builds`);
                return false;
            }

            const protectedTagFound = protectedBuildNumbers.find((protectedBuildNumber) => protectedBuildNumber.buildNumber === build.buildNumber);
            if (protectedTagFound) {
                console.error(`[DELETE OLD BUILDS][${this.actorName}]: Skipping protected build ${protectedTagFound.buildNumber} (${protectedTagFound.tag}).`);
                return false;
            }

            if (taggedDevelBuildNumber && build.buildNumber === taggedDevelBuildNumber) {
                const shouldDeleteDevelBuild = build.startedAt.getTime() < daysAgoUnixDevel;
                if (shouldDeleteDevelBuild) {
                    console.error(`[DELETE OLD BUILDS][${this.actorName}]: Removing olf devel build ${taggedDevelBuildNumber}.`);
                }
                return shouldDeleteDevelBuild;
            }
            return build.startedAt.getTime() < daysAgoUnixProd;
        });

        console.error(`[DELETE OLD BUILDS][${this.actorName}]: Deleting ${buildsToDelete.length} old builds that are non-default and `
            + `older than 30 days from total ${items.length}`);
        for (const build of buildsToDelete) {
            await this.apifyClient.build(build.id).delete();
        }
    }

    async getDefaultBuilt() {
        const client = this.apifyClient.actor(this.actorName)
        const { defaultVersionNumber } = await this.getDefaultVersionAndTag()
        const { id, actId, buildNumber } = await client.build(defaultVersionNumber)
        return { buildId: id, actorId: actId, buildNumber, actorName: this.actorName };
    }
}

type RunBuildsOptions = {
    actorConfigs: ActorConfig[]
    isLatest?: boolean
    repoUrl: string
    branch: string
    dryRun: boolean
}

export const getAllDefaultBuilds = async (actorConfigs: ActorConfig[]) => {
    const existingBuilds = await Promise.all(
        actorConfigs.map(actor =>
            ApifyBuilder.fromActorName(actor.actorName).getDefaultBuilt()
        )
    );
    return existingBuilds;
}

export const runBuilds = async ({
    repoUrl,
    branch,
    actorConfigs,
    isLatest = false,
    dryRun,
}: RunBuildsOptions) => {
    const buildConfigs: BuildPrActorOptions[] = [];

    const circleActors = isLatest ? await findCircleApifyManaged(actorConfigs) : [];

    for (const { actorName, folder } of actorConfigs.concat(circleActors)) {
        let versionNumber: string;
        let buildTag: string | undefined;

        if (isLatest) {
            const { defaultVersionNumber, defaultBuildTag } = await ApifyBuilder.fromActorName(actorName).getDefaultVersionAndTag();
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
        buildConfigs.push({ actorName, gitRepoUrl, versionNumber, buildTag });
    }

    if (dryRun) {
        return buildConfigs;
    }
    console.error("=========================================");
    console.error("STARTED BUILDS:");
    const startedBuilds = await Promise.all(buildConfigs.map(async (buildConfig) => {
        const builder = ApifyBuilder.fromActorName(buildConfig.actorName);
        const buildData = await builder.startActorBuild(buildConfig);
        return buildData;
    }));
    console.error("=========================================");

    await Promise.all(startedBuilds.map(async (buildData) => {
        const builder = ApifyBuilder.fromActorName(buildData.actorName);
        await builder.waitForBuildToFinish(buildData.buildId, buildData.actorName);
    }));

    console.error("FINISHED BUILDS:");
    for (const buildData of startedBuilds.sort((a, b) => a.actorName.localeCompare(b.actorName))) {
        console.error(`[${buildData.actorName}]: ${buildData.buildId}`);
    }
    console.error("=========================================");

    return startedBuilds;
};

export const deleteOldBuilds = async (actorConfigs: ActorConfig[]) => {
    for (const { actorName } of actorConfigs) {
        await ApifyBuilder.fromActorName(actorName).deleteOldBuilds();
    }
};

/**
 * We will read all Actors in the circ_le account and build those that match by name pattern
 * There are many ways to approach this, a more robust one would be to have a map of Actors
 * which would allow to have more than one special user per Actor
 * But since that use-case might never be needed, I went with the simplest solution that doesn't require maintaining the map
 * NOTE: One issue is that if any Actor is renamed, we will not match it in the circ_le account nor throw any error
 */
const findCircleApifyManaged = async (actorConfigs: ActorConfig[]): Promise<ActorConfig[]> => {
    // This token is hardcoded in the runner Actor, locally you have to inject it
    const client = new ApifyClient({ token: getEnvVar('APIFY_TOKEN_CIRC_LE') });

    const { items: circleActors } = await client.actors().list();

    const actorsToBuild = circleActors.map<ActorConfig | undefined>((circleActor) => {
        // They prefix all with apify-managed---, I communicated with Jacques to keep doing that
        let actorConfigFound = actorConfigs.find((actorConfig) => circleActor.name.replace('apify-managed---', '') === actorConfig.actorName.split('/')[1]);

        // Hack for bad naming of circ_le/apify-managed-google-search, we don't want to rename now to break customers
        if (!actorConfigFound && circleActor.name === 'apify-managed-google-search') {
            actorConfigFound = actorConfigs.find((actorConfig) => actorConfig.actorName.split('/')[1] === 'google-search-scraper');
        }

        if (actorConfigFound) {
            return {
                // We point the circle Actor to the repo folder
                actorName: `${circleActor.username}/${circleActor.name}`,
                folder: actorConfigFound.folder,
                isStandalone: actorConfigFound.isStandalone,
            };
        }
        return undefined;
    }).filter((config) => config !== undefined);

    console.error(`Found ${actorsToBuild.length} circ_le actors that match Actors we built out of total ${circleActors.length} circ_le actors`);
    console.error(`All circ_le actors: ${circleActors.map((actor) => actor.name).join(', ')}`);
    console.error(`circ_le Actors to build: ${actorsToBuild.map((actor) => actor.actorName).join(', ')}`);

    if (actorsToBuild.length === 0) {
        console.error('No circ_le actors to build');
    }
    return actorsToBuild;
};
