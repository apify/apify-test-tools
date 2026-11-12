import { ActorSource, zipFiles } from './actor-source.js';
import {
    ApifyBuilder,
    assertEnvVarsMatchDefaultVersion,
    LOCAL_SOURCE_VERSION_NUMBER,
    resolveDefaultVersion,
    runAndSummarizeBuilds,
} from './build.js';
import { logger } from './logger.js';
import type { ActorConfig, BuildData, DryRunPlan } from './types.js';

type LocalBuildPlan = {
    actorFullName: string;
    versionNumber: string;
    folder: string;
    fileCount: number;
    zipSizeBytes: number;
};

export const runBuildsFromLocal = async ({
    actorConfigs,
    dryRun,
    requireEnvVarsInSync = false,
}: {
    actorConfigs: ActorConfig[];
    dryRun: boolean;
    // See assertEnvVarsMatchDefaultVersion
    requireEnvVarsInSync?: boolean;
}): Promise<BuildData[] | DryRunPlan<LocalBuildPlan>> => {
    // Read-only preparation shared with the real build, so a dry run fails on a missing token, an unknown
    // Actor or unreadable sources just like the build would
    const preparedBuilds = await Promise.all(
        actorConfigs.map(async (actorConfig) => {
            const actorInfo = await ApifyBuilder.fromActorConfig(actorConfig).getActorInfo();
            if (requireEnvVarsInSync) {
                const { defaultVersion } = resolveDefaultVersion(actorConfig.actorFullName, actorInfo);
                assertEnvVarsMatchDefaultVersion(
                    actorConfig.actorFullName,
                    actorInfo,
                    defaultVersion,
                    LOCAL_SOURCE_VERSION_NUMBER,
                );
            }
            const files = await ActorSource.actor(actorConfig).files();
            const zipBuffer = zipFiles(files);
            return { actorConfig, actorInfo, fileCount: files.size, zipBuffer };
        }),
    );

    if (dryRun) {
        logger.info('[DRY RUN] Would build from local source:');
        for (const { actorConfig, fileCount, zipBuffer } of preparedBuilds) {
            logger.info(
                `  ${actorConfig.actorFullName} (${actorConfig.folder}): ${fileCount} files, ${zipBuffer.length} bytes zipped`,
            );
        }
        return {
            dryRun: true,
            builds: preparedBuilds.map(({ actorConfig, fileCount, zipBuffer }) => ({
                actorFullName: actorConfig.actorFullName,
                versionNumber: LOCAL_SOURCE_VERSION_NUMBER,
                folder: actorConfig.folder.path,
                fileCount,
                zipSizeBytes: zipBuffer.length,
            })),
        };
    }

    const preparedByActorFullName = new Map(
        preparedBuilds.map((prepared) => [prepared.actorConfig.actorFullName, prepared]),
    );

    return runAndSummarizeBuilds(actorConfigs, 'LOCAL BUILDS', async (actorConfig, builder) => {
        const { actorInfo, zipBuffer } = preparedByActorFullName.get(actorConfig.actorFullName)!;
        return builder.buildFromLocalSource(zipBuffer, { actorInfo });
    });
};
