import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { type ActorGetter, withActorIds } from './actor-ids.js';
import { getChangedFilesBetween } from './git.js';
import { logger } from './logger.js';
import { resolveVitestBin } from './run-tests.js';
import type { SelectChangedTestsInput } from './stdin-input.js';
import { createTestFilesMatcher } from './test-files-glob.js';
import type { ActorConfig } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Vitest follows `import`s, but not files a test reads at run time, such as a JSON fixture read with `fs`. A change to
 * any other kind of file in `platformTestsGlob` could change a test that vitest doesn't see, so it runs every test.
 * Markdown is documentation and changes no test.
 */
const MODULE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const DOC_EXTENSIONS = new Set(['.md']);

/** How a test's full name from `vitest list` names its Actor: the lib calls every test `<actorId>: <name>` */
const actorIdOfTest = (fullName: string): string | undefined => {
    // Suites come first, joined with ' > '
    const segments = fullName.split(' > ');
    const testName = segments[segments.length - 1];
    const separator = testName.indexOf(': ');
    return separator === -1 ? undefined : testName.slice(0, separator);
};

/** Runs `vitest list` in the repository and returns its JSON output. */
const vitestList = async (
    args: string[],
    { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ file: string; name?: string }[]> => {
    const vitestBin = await resolveVitestBin(cwd);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apify-test-tools-list-'));
    const outputFile = path.join(tempDir, 'list.json');
    try {
        // Written to a file, so nothing the tests print at import time can end up in the JSON
        await execFileAsync(process.execPath, [vitestBin, 'list', ...args, `--json=${outputFile}`], {
            cwd,
            env,
            maxBuffer: 64 * 1024 * 1024,
        });
        return JSON.parse(await fs.readFile(outputFile, 'utf8'));
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
};

interface ChangedTestsSelection {
    /** The Actors with test changes whose tests are narrowed, each to the test files that changed */
    narrowed: Map<string, string[]>;
}

/** Thrown when the changed tests can't be told for certain, so every test of the test-changed Actors runs. */
class NotConfidentError extends Error {}

/**
 * Finds the test files the changes since `since` affect, and the Actors their tests name. Vitest follows imports, so
 * a changed helper selects every test file that imports it.
 */
const findChangedTests = async ({
    since,
    head,
    platformTestsGlob,
    actorConfigs,
    cwd,
    client,
}: {
    since: string;
    head: string;
    platformTestsGlob: string;
    actorConfigs: ActorConfig[];
    cwd: string;
    client?: ActorGetter;
}): Promise<ChangedTestsSelection> => {
    const isTestFile = createTestFilesMatcher(platformTestsGlob);
    const changedTestFiles = (await getChangedFilesBetween(since, head)).filter((file) => isTestFile(file));
    const untracked = changedTestFiles.filter((file) => {
        const extension = path.posix.extname(file).toLowerCase();
        return !MODULE_EXTENSIONS.has(extension) && !DOC_EXTENSIONS.has(extension);
    });
    if (untracked.length !== 0) {
        throw new NotConfidentError(`vitest can't see which tests read ${untracked.join(', ')}`);
    }

    const root = await fs.realpath(cwd);
    const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');
    // No path filters: with any, vitest no longer follows imports from the changed files and misses changed helpers.
    // The platform tests are picked from its output instead.
    const affectedFiles = (await vitestList(['--changed', since, '--filesOnly'], { cwd, env: process.env }))
        .map(({ file }) => file)
        .filter((file) => isTestFile(relative(file)))
        .sort();
    if (affectedFiles.length === 0) return { narrowed: new Map() };

    // Every Actor of the config, by both IDs, so vitest lists every test of the affected files, however it names
    // its Actor. The lib skips tests of Actors that aren't listed, and `vitest list` leaves skipped tests out.
    const targets = await withActorIds(
        actorConfigs.map(({ actorFullName }) => ({ actorFullName })),
        client,
    );
    const fullNameOf = new Map<string, string>();
    for (const { actorFullName, actorRawId } of targets) {
        fullNameOf.set(actorFullName!, actorFullName!);
        if (actorRawId) fullNameOf.set(actorRawId, actorFullName!);
    }
    const tests = await vitestList(affectedFiles, {
        cwd,
        env: {
            ...process.env,
            ACTOR_BUILDS: JSON.stringify(targets),
            // The lib skips every test without a token, and nothing runs here
            TESTER_APIFY_TOKEN: process.env.TESTER_APIFY_TOKEN || 'list-only',
        },
    });

    const narrowed = new Map<string, string[]>();
    for (const file of affectedFiles) {
        const actors = new Set(
            tests
                .filter((test) => test.file === file && test.name !== undefined)
                .map((test) => fullNameOf.get(actorIdOfTest(test.name!) ?? '')),
        );
        // A test of an Actor that isn't in the config, or that the tester token can't see, can't be mapped either
        if (actors.size === 0 || actors.has(undefined)) {
            throw new NotConfidentError(`can't tell which Actors ${relative(file)} tests`);
        }
        for (const actor of actors) narrowed.set(actor!, [...(narrowed.get(actor!) ?? []), relative(file)]);
    }
    return { narrowed };
};

/**
 * Narrows `testChangedActors` of a `get-affected-actors --base` document to the Actors whose affected tests changed,
 * and gives each the test files to run. An Actor the document doesn't list is never added. When the changed tests
 * can't be told for certain, the document stays as it is, so every test of those Actors runs.
 */
export const selectChangedTests = async ({
    affected,
    platformTestsGlob,
    actorConfigs,
    cwd = process.cwd(),
    client,
}: {
    affected: SelectChangedTestsInput;
    platformTestsGlob: string;
    actorConfigs: ActorConfig[];
    cwd?: string;
    /** For tests: looks up the raw IDs, instead of the Apify API */
    client?: ActorGetter;
}) => {
    if (affected.testChangedActors.length === 0) return { ...affected, changedTests: { narrowed: true } };

    let selection: ChangedTestsSelection;
    try {
        selection = await findChangedTests({
            since: affected.testChangesSince,
            head: affected.head,
            platformTestsGlob,
            actorConfigs,
            cwd,
            client,
        });
    } catch (error) {
        const reason =
            error instanceof NotConfidentError
                ? error.message
                : `listing the tests failed: ${(error as Error).message}`;
        logger.warn(`[CHANGED TESTS]: Running every test of the Actors with test changes, since ${reason}`);
        return { ...affected, changedTests: { narrowed: false, reason } };
    }

    const testChangedActors = affected.testChangedActors
        .filter(({ actorFullName }) => selection.narrowed.has(actorFullName))
        .map((actor) => ({ ...actor, testFiles: selection.narrowed.get(actor.actorFullName)! }));
    for (const { actorFullName, testFiles } of testChangedActors) {
        logger.info(`[CHANGED TESTS]: ${actorFullName}: ${testFiles.join(', ')}`);
    }
    const dropped = affected.testChangedActors.filter(({ actorFullName }) => !selection.narrowed.has(actorFullName));
    if (dropped.length !== 0) {
        logger.info(
            `[CHANGED TESTS]: No changed test names ${dropped.map(({ actorFullName }) => actorFullName).join(', ')}`,
        );
    }
    return { ...affected, testChangedActors, changedTests: { narrowed: true } };
};
