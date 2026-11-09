import fs from 'node:fs/promises';

import z from 'zod';

import { logger } from './logger.js';

/**
 * A build of a PR branch that an earlier run of the PR workflow made and tested. The workflow keeps them in its cache,
 * next to the last validated commit. Other fields, e.g. from an older format, are ignored.
 */
const storedBuildSchema = z.object({
    actorFullName: z.string(),
    buildId: z.string(),
    actorRawId: z.string(),
    buildNumber: z.string(),
});

export type StoredBuild = z.infer<typeof storedBuildSchema>;

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
            `Stored builds file ${filePath} is not valid, so the Actors whose code the branch changed are built ` +
                `again: ${(error as Error).message}`,
        );
        return [];
    }
};
