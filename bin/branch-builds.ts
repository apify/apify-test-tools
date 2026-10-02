import fs from 'node:fs';

import type { ActorConfig, BuildData } from './types.js';

export const readBranchBuilds = (filePath: string): BuildData[] =>
    fs.existsSync(filePath) ? (JSON.parse(fs.readFileSync(filePath, 'utf8')) as BuildData[]) : [];

type PlanBranchBuildsOptions = {
    // Actors whose code the whole branch changes
    branchActors: ActorConfig[];
    // Actors whose code changed since the last validated commit
    actorsChanged: ActorConfig[];
    previousBuilds: BuildData[];
    buildExists: (actorConfig: ActorConfig, build: BuildData) => Promise<boolean>;
};

/**
 * An Actor that the branch changes is tested against a build of this branch, never against the deployed build.
 * Reuse the earlier branch build if it still exists, otherwise build the Actor again.
 */
export const planBranchBuilds = async ({
    branchActors,
    actorsChanged,
    previousBuilds,
    buildExists,
}: PlanBranchBuildsOptions) => {
    const actorsToBuild = [...actorsChanged];
    const reusedBuilds: BuildData[] = [];

    for (const actorConfig of branchActors) {
        const { actorFullName } = actorConfig;
        if (actorsChanged.some((changed) => changed.actorFullName === actorFullName)) continue;

        const previousBuild = previousBuilds.find((build) => build.actorFullName === actorFullName);
        if (!previousBuild) {
            console.error(`[BRANCH-BUILDS]: No earlier build of this branch for ${actorFullName}, building it`);
            actorsToBuild.push(actorConfig);
        } else if (!(await buildExists(actorConfig, previousBuild))) {
            console.error(
                `[BRANCH-BUILDS]: Earlier build ${previousBuild.buildId} of ${actorFullName} no longer exists, building it again`,
            );
            actorsToBuild.push(actorConfig);
        } else {
            console.error(`[BRANCH-BUILDS]: Reusing build ${previousBuild.buildNumber} of ${actorFullName}`);
            reusedBuilds.push(previousBuild);
        }
    }

    return { actorsToBuild, reusedBuilds };
};
