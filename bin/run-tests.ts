import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { FALLBACK_TOKEN_ENV_VAR, withTestTokens } from './actor-ids.js';
import {
    findInstalledLibVersion,
    findPackageDir,
    isOlderVersion,
    OLDEST_SUPPORTED_LIB_VERSION,
    readPackageJson,
} from './lib-compat.js';
import { logger } from './logger.js';
import type { TestTarget } from './stdin-input.js';
import { resolveTestFilesGlob } from './test-files-glob.js';
import {
    failedRunReport,
    logTestReport,
    requireTestsToRun,
    type TestReport,
    toTestReport,
    type VitestJsonReport,
} from './test-report.js';
import { CONFIG_FILE_NAME, readTestTokenEnvVars } from './utils/config/load-config.js';

/**
 * Finds the vitest the repository installed. The CLI ships as a bundle that runs outside the repository's
 * `node_modules`, so the tests keep the vitest (and the lib) version the repository locked. Read from `package.json`
 * because vitest's exports don't expose its bin.
 */
const resolveVitestBin = async (cwd: string): Promise<string> => {
    const packageDir = findPackageDir(cwd, 'vitest');
    if (!packageDir) throw new Error(`vitest is not installed in ${cwd}, install the repository's dependencies first`);
    const { bin } = await readPackageJson(packageDir);
    return path.join(packageDir, typeof bin === 'string' ? bin : bin.vitest);
};

/**
 * The version of the `ACTOR_BUILDS` format this CLI writes, which the lib declares it reads in its `package.json`.
 * Version 2 names each Actor's test token instead of one `TESTER_APIFY_TOKEN` for all.
 */
const ACTOR_BUILDS_VERSION = 2;

/**
 * Checks the lib reads the `ACTOR_BUILDS` this CLI writes. An older lib runs every test with `TESTER_APIFY_TOKEN` and
 * ignores the Actors' own tokens, which is fine while that token is set: a warning says so. Without it, such a lib
 * skips every test and the run would pass having tested nothing, so that is an error. A repository that doesn't
 * install the lib where vitest can find it is left alone: its tests can't import it either.
 */
const checkLibReadsActorBuilds = async (cwd: string) => {
    const packageDir = findPackageDir(cwd, 'apify-test-tools');
    if (!packageDir) return;
    const { version, apifyTestTools } = await readPackageJson(packageDir);
    if ((apifyTestTools?.actorBuildsVersion ?? 1) >= ACTOR_BUILDS_VERSION) return;
    const outdated =
        `apify-test-tools ${version} installed in this repository runs every test with ${FALLBACK_TOKEN_ENV_VAR}, ` +
        `not with each Actor's token from ${CONFIG_FILE_NAME}.`;
    if (!process.env[FALLBACK_TOKEN_ENV_VAR]) {
        throw new Error(
            `${outdated} ${FALLBACK_TOKEN_ENV_VAR} is not set, so it would skip every test. Update apify-test-tools ` +
                `in the repository, or set ${FALLBACK_TOKEN_ENV_VAR}.`,
        );
    }
    logger.warn(`${outdated} Update it to test each Actor with its own token.`);
};

/**
 * Turns the glob into vitest filters. Vitest filters are parts of a file path, not globs, so the glob is resolved here.
 * The filters are the folders that hold only matched files and the other matched files one by one, so the command
 * line stays short. They go to vitest as absolute paths. Vitest also matches their path relative to the root anywhere
 * in a test file's path, so a copy at `dist/test/platform/a.test.ts` would run too: vitest's own `exclude` keeps such
 * copies out.
 */
const resolveVitestFilters = async (testFilesGlob: string, cwd: string): Promise<string[]> => {
    const { files, paths } = await resolveTestFilesGlob(testFilesGlob, cwd);
    // Without filters vitest would run every test of the repo
    if (files.length === 0) {
        throw new Error(
            `No files match --test-files-glob "${testFilesGlob}". The glob is relative to the repo root, e.g. "test/platform/**".`,
        );
    }
    logger.info(`Running the ${files.length} file(s) that match --test-files-glob "${testFilesGlob}"`);
    logger.debug(`Files: ${files.join(', ')}`);
    // Vitest compares against real paths, and cwd can be a symlink (e.g. /tmp on macOS). join keeps a folder's
    // trailing slash, which stops `test/platform/daily/` from also matching `test/platform/daily-without-pr/`.
    const root = await fs.realpath(cwd);
    return paths.map((filePath) => path.join(root, filePath));
};

interface RunTestsOptions {
    /** Glob from the repo root (`cwd`) of the test files to run, e.g. `test/platform/**` */
    testFilesGlob: string;
    /** The Actors to test, each with its build or, without one, its default build */
    targets: TestTarget[];
    /** Keeps vitest's own JSON report there, e.g. to upload it */
    vitestOutputFile?: string;
    /** Vitest reporters to add to the default one and the JSON one the report is read from, e.g. `github-actions` */
    reporters?: string[];
    cwd?: string;
}

/**
 * Runs the repository's vitest on the given builds and returns what happened as a `TestReport`. Vitest's own output
 * goes to stderr, so stdout stays free for the report. A failing test or a crashing vitest is a failed report, not
 * an error: the report is how the failure gets to `notify`.
 */
export const runTests = async ({
    testFilesGlob,
    targets,
    vitestOutputFile,
    reporters = [],
    cwd = process.cwd(),
}: RunTestsOptions): Promise<TestReport> => {
    const vitestBin = await resolveVitestBin(cwd);
    const libVersion = await findInstalledLibVersion(cwd);
    if (libVersion && isOlderVersion(libVersion, OLDEST_SUPPORTED_LIB_VERSION)) {
        logger.warn(
            `The repository uses apify-test-tools ${libVersion}, older than ${OLDEST_SUPPORTED_LIB_VERSION}, the oldest ` +
                'version this CLI supports. Its tests may be skipped. Update apify-test-tools in package.json.',
        );
    }
    const vitestFilters = await resolveVitestFilters(testFilesGlob, cwd);
    await checkLibReadsActorBuilds(cwd);
    // Each Actor's tests run with the token the config names for it. A test only runs when the ID it names its Actor
    // by is listed, so each Actor gets both its full name and raw ID.
    const actorBuilds = await withTestTokens(targets, { testTokenEnvVars: await readTestTokenEnvVars() });

    const tempDir = vitestOutputFile ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'apify-test-tools-'));
    const outputFile = path.resolve(cwd, vitestOutputFile ?? path.join(tempDir!, 'vitest-report.json'));
    // A report left over from an earlier run must not pass for this one's
    await fs.rm(outputFile, { force: true });

    // Stdin is the only source of what to test, so whatever the caller's environment holds doesn't leak into the tests
    const env = { ...process.env };
    // Vitest writes to a pipe, so it would drop colors that the terminal it ends up in shows
    if (process.stderr.isTTY && env.FORCE_COLOR === undefined && env.NO_COLOR === undefined) env.FORCE_COLOR = '1';
    // The lib runs the tests of the Actors listed here, each on the build given, or on its default build without one,
    // with the token in the env var named with it.
    // Lib versions before 0.9.0 read the IDs as actorName and actorId, so they are given under both names
    env.ACTOR_BUILDS = JSON.stringify(
        actorBuilds.map((build) => ({ ...build, actorName: build.actorFullName, actorId: build.actorRawId })),
    );
    // Lib versions before 0.10.0 skip every test in their `describe` unless this is set. Newer versions read
    // ACTOR_BUILDS instead and ignore it. It only unlocks `describe`: which tests run still follows ACTOR_BUILDS.
    env.RUN_PLATFORM_TESTS = '1';
    // In those versions this runs the tests of every Actor, whatever ACTOR_BUILDS lists
    delete env.RUN_ALL_PLATFORM_TESTS;
    const described = actorBuilds.map(
        ({ actorFullName, actorRawId, buildNumber, testTokenEnvVar }) =>
            `${actorFullName ?? actorRawId} (${buildNumber ?? 'default build'}, ${testTokenEnvVar ?? 'no own token'})`,
    );
    logger.info(`Testing ${targets.length} Actor(s): ${described.join(', ') || 'none'}`);

    const args = [
        vitestBin,
        'run',
        ...vitestFilters,
        '--reporter=default',
        '--reporter=json',
        ...reporters.map((reporter) => `--reporter=${reporter}`),
        `--outputFile.json=${outputFile}`,
        // Platform tests mostly wait on Actor runs, not on the CPU, so they run far more at once than vitest's defaults
        '--maxConcurrency=20',
        '--fileParallelism',
        '--maxWorkers=100',
    ];
    logger.debug(`Running vitest: ${args.join(' ')}`);

    try {
        const exitCode = await spawnVitest(args, { cwd, env });
        let vitestReport: VitestJsonReport;
        try {
            vitestReport = JSON.parse(await fs.readFile(outputFile, 'utf8'));
        } catch (error) {
            logger.debug(`Could not read the vitest report: ${(error as Error).message}`);
            const report = failedRunReport(
                `Vitest exited with code ${exitCode} without a report, see its output above`,
            );
            logTestReport(report);
            return report;
        }
        const report = requireTestsToRun(toTestReport(vitestReport, { cwd, exitCode }), actorBuilds);
        logTestReport(report);
        return report;
    } finally {
        if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    }
};

/** Resolves with vitest's exit code. Signals we get (a cancelled CI job) are passed on, so vitest can clean up. */
const spawnVitest = async (args: string[], { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv }) =>
    new Promise<number>((resolve, reject) => {
        // Vitest's stdout goes to our stderr: stdout is reserved for the report. It is piped through us rather than
        // handed over, to leave out the JSON reporter's note about the temporary file it wrote.
        const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 2] });
        createInterface({ input: child.stdout!, crlfDelay: Infinity }).on('line', (line) => {
            if (!line.startsWith('JSON report written to ')) process.stderr.write(`${line}\n`);
        });
        const forward = (signal: NodeJS.Signals) => child.kill(signal);
        process.on('SIGINT', forward);
        process.on('SIGTERM', forward);
        const cleanup = () => {
            process.off('SIGINT', forward);
            process.off('SIGTERM', forward);
        };
        child.on('error', (error) => {
            cleanup();
            reject(new Error(`Failed to start vitest: ${error.message}`));
        });
        child.on('close', (code, signal) => {
            cleanup();
            if (signal) logger.warn(`Vitest was stopped by ${signal}`);
            resolve(code ?? 1);
        });
    });
