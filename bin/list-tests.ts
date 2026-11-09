import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import { withActorIds } from './actor-ids.js';
import type { TestTarget } from './stdin-input.js';
import { resolveVitestBin } from './vitest.js';

const execFileAsync = promisify(execFile);
const listedTestsSchema = z.array(z.object({ file: z.string() }));

interface CollectPlatformTestFilesOptions {
    /** All configured Actors, as returned by get-actor-configs, or targets with both IDs already resolved. */
    targets: TestTarget[];
    cwd?: string;
}

/** Finds platform test files by enabling the configured Actors. Ordinary and platform tests must be in separate files. */
export const collectPlatformTestFiles = async ({
    targets,
    cwd = process.cwd(),
}: CollectPlatformTestFilesOptions): Promise<Set<string>> => {
    const token = process.env.TESTER_APIFY_TOKEN;
    if (!token) {
        throw new Error(
            'TESTER_APIFY_TOKEN is not set. Platform test discovery needs it to enable the configured Actors.',
        );
    }
    const repoRoot = path.resolve(cwd);
    const vitestBin = await resolveVitestBin(repoRoot);
    const actorBuilds = await withActorIds(targets);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apify-list-tests-'));
    const env = { ...process.env };
    // Keep the baseline independent of the caller's credentials and selected Actors.
    delete env.TESTER_APIFY_TOKEN;
    delete env.ACTOR_BUILDS;
    delete env.RUN_PLATFORM_TESTS;
    delete env.RUN_ALL_PLATFORM_TESTS;

    const collect = async (allPlatformTests: boolean) => {
        const outputFile = path.join(tempDir, allPlatformTests ? 'platform.json' : 'baseline.json');
        // Consumer configs and test modules can log to stdout; keep their output separate from the JSON.
        await execFileAsync(process.execPath, [vitestBin, 'list', `--json=${outputFile}`, '--passWithNoTests'], {
            cwd: repoRoot,
            env: allPlatformTests
                ? { ...env, TESTER_APIFY_TOKEN: token, ACTOR_BUILDS: JSON.stringify(actorBuilds) }
                : env,
            maxBuffer: 100 * 1024 * 1024,
        });
        return listedTestsSchema.parse(JSON.parse(await fs.readFile(outputFile, 'utf8')));
    };

    try {
        const baseline = await collect(false);
        const all = await collect(true);
        const key = (test: z.infer<typeof listedTestsSchema>[number]) => test.file;

        const regularTests = new Set(baseline.map(key));
        // Platform-only files have no enabled tests in the baseline collection.
        return new Set(
            all
                .filter((test) => !regularTests.has(key(test)))
                .map((test) => path.relative(repoRoot, test.file).split(path.sep).join('/')),
        );
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
};
