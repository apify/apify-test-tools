import fs from 'node:fs/promises';

import z from 'zod';

import { logger } from './logger.js';
import type { PrBuildPlanInput } from './stdin-input.js';

/**
 * `delete-old-builds` deletes builds older than 30 days. A stored build is used only while it is clearly younger, so
 * the tests never ask for a build that is gone.
 */
const MAX_STORED_BUILD_AGE_DAYS = 25;

/**
 * A build of the PR branch that an earlier run of the PR workflow built and tested. The workflow keeps them in its
 * cache, next to the last validated commit. `builtAt` is in Unix seconds.
 */
const storedBuildSchema = z.object({
    actorFullName: z.string(),
    buildId: z.string(),
    actorRawId: z.string(),
    buildNumber: z.string(),
    builtAt: z.number(),
});

type StoredBuild = z.infer<typeof storedBuildSchema>;

/** An Actor to test on a build that already exists: a stored build, or its default build when it has no build fields */
type ExistingBuild = Omit<StoredBuild, 'builtAt'> | { actorFullName: string };

/** The JSON document `plan-pr-builds` prints. Versioned, since the PR workflow consumes it. */
interface PrBuildPlan {
    version: 1;
    /** The input of `build`: the Actors that need a new build of the branch */
    build: { actors: { actorFullName: string }[] };
    /** Actors whose tests run on an existing build. Add them to the builds `build` prints to get the input of `test` */
    existingBuilds: ExistingBuild[];
}

/**
 * Reads the stored builds. A missing file (the first run, or an evicted cache) has none. A file that can't be read is
 * treated the same, with a warning: the Actors are then built again, which is slower but always correct.
 */
export const readStoredBuilds = async (filePath: string | undefined): Promise<StoredBuild[]> => {
    if (!filePath) return [];
    let raw: string;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    try {
        return z.array(storedBuildSchema).parse(JSON.parse(raw));
    } catch (error) {
        logger.warn(
            `Stored builds file ${filePath} is not valid, so every Actor that needs a build of the branch is built ` +
                `again: ${(error as Error).message}`,
        );
        return [];
    }
};

/**
 * Decides which Actors a PR run builds and which it tests on existing builds:
 * - An Actor with a functional change since the last validated commit is built.
 * - An Actor with only test changes whose code is the same as on base is tested on its default build.
 * - An Actor with only test changes whose code the branch changed is tested on the build an earlier run of this PR
 *   made and tested. That build has the current code: a functional change after it would have built the Actor again.
 *   Without such a build (the first run after the cache was evicted, or the build is too old), it is built.
 */
export const planPrBuilds = ({
    affected,
    storedBuilds,
    now = Date.now(),
}: {
    affected: PrBuildPlanInput;
    storedBuilds: StoredBuild[];
    /** Unix milliseconds */
    now?: number;
}): PrBuildPlan => {
    const minBuiltAt = now / 1000 - MAX_STORED_BUILD_AGE_DAYS * 24 * 60 * 60;
    const functional = new Set(affected.functionallyChangedActors.map(({ actorFullName }) => actorFullName));
    const toBuild = [...functional];
    const existingBuilds: ExistingBuild[] = [];

    for (const { actorFullName, needsBranchBuild } of affected.testChangedActors) {
        if (functional.has(actorFullName)) continue;
        if (!needsBranchBuild) {
            logger.info(
                `[PLAN]: ${actorFullName} has only test changes and the code of base, so its default build runs the tests`,
            );
            existingBuilds.push({ actorFullName });
            continue;
        }
        const stored = storedBuilds.find(
            (build) => build.actorFullName === actorFullName && build.builtAt >= minBuiltAt,
        );
        if (stored) {
            const { builtAt: _builtAt, ...build } = stored;
            logger.info(
                `[PLAN]: ${actorFullName} has only test changes since its build ${build.buildNumber}, which runs the tests`,
            );
            existingBuilds.push(build);
            continue;
        }
        logger.info(
            `[PLAN]: ${actorFullName} has only test changes, but no stored build of the branch, so it is built`,
        );
        toBuild.push(actorFullName);
    }

    return {
        version: 1,
        build: { actors: toBuild.map((actorFullName) => ({ actorFullName })) },
        existingBuilds,
    };
};
