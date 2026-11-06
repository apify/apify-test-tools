import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { withActorIds } from './actor-ids.js';
import { logger } from './logger.js';
import type { TestTarget } from './stdin-input.js';
import { resolveTestFilesGlob } from './test-files-glob.js';
import { failedRunReport, logTestReport, type TestReport, toTestReport, type VitestJsonReport } from './test-report.js';

/**
 * Finds the vitest the repository installed, the way Node would resolve it from `cwd`. The CLI ships as a bundle
 * that runs outside the repository's `node_modules`, so the tests keep the vitest (and the lib) version the
 * repository locked. Read from `package.json` because vitest's exports don't expose its bin.
 */
const resolveVitestBin = async (cwd: string): Promise<string> => {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
        const packageDir = path.join(dir, 'node_modules', 'vitest');
        if (existsSync(path.join(packageDir, 'package.json'))) {
            const { bin } = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
            return path.join(packageDir, typeof bin === 'string' ? bin : bin.vitest);
        }
        if (path.dirname(dir) === dir) {
            throw new Error(`vitest is not installed in ${cwd}, install the repository's dependencies first`);
        }
    }
};

/** What `test` runs when it gets neither filters nor a glob */
const DEFAULT_FILTERS = ['test/platform'];

/**
 * Turns what `test` was given into vitest filters. Vitest filters are substrings of the file paths, not globs, so
 * the glob is resolved here into the files it matches. They go to vitest as absolute paths, which vitest matches
 * from the start of the path, so `test/platform/a.test.ts` does not also run `other/test/platform/a.test.ts`.
 */
const resolveVitestFilters = async ({
    filters,
    testFilesGlob,
    cwd,
}: Pick<RunTestsOptions, 'filters' | 'testFilesGlob'> & { cwd: string }): Promise<string[]> => {
    if (testFilesGlob === undefined) return filters.length !== 0 ? filters : DEFAULT_FILTERS;
    if (filters.length !== 0) throw new Error('Pass either test filters or --test-files-glob, not both.');
    const files = await resolveTestFilesGlob(testFilesGlob, cwd);
    // Without filters vitest would run every test of the repo
    if (files.length === 0) {
        throw new Error(
            `No files match --test-files-glob "${testFilesGlob}". The glob is relative to the repo root, e.g. "test/platform/**".`,
        );
    }
    logger.info(`Running the ${files.length} file(s) that match --test-files-glob "${testFilesGlob}"`);
    logger.debug(`Files: ${files.join(', ')}`);
    // Vitest compares against real paths, and cwd can be a symlink (e.g. /tmp on macOS)
    const root = await fs.realpath(cwd);
    return files.map((file) => path.join(root, file));
};

interface RunTestsOptions {
    /** Vitest file filters, e.g. `test/platform/core`. Empty runs `test/platform`, unless `testFilesGlob` is given */
    filters: string[];
    /** Glob from the repo root (`cwd`) of the test files to run, e.g. `test/platform/**`. Replaces `filters` */
    testFilesGlob?: string;
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
    filters,
    testFilesGlob,
    targets,
    vitestOutputFile,
    reporters = [],
    cwd = process.cwd(),
}: RunTestsOptions): Promise<TestReport> => {
    // Without it the lib skips every platform test, and a run that tested nothing would pass
    if (!process.env.TESTER_APIFY_TOKEN) {
        throw new Error('TESTER_APIFY_TOKEN is not set. The platform tests need it to run the Actors.');
    }
    const vitestBin = await resolveVitestBin(cwd);
    const vitestFilters = await resolveVitestFilters({ filters, testFilesGlob, cwd });
    // A test only runs when the ID it names its Actor by is listed, so each Actor gets both its full name and raw ID
    const actorBuilds = await withActorIds(targets);

    const tempDir = vitestOutputFile ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'apify-test-tools-'));
    const outputFile = path.resolve(cwd, vitestOutputFile ?? path.join(tempDir!, 'vitest-report.json'));
    // A report left over from an earlier run must not pass for this one's
    await fs.rm(outputFile, { force: true });

    // Stdin is the only source of what to test, so whatever the caller's environment holds doesn't leak into the tests
    const env = { ...process.env };
    // Vitest writes to a pipe, so it would drop colors that the terminal it ends up in shows
    if (process.stderr.isTTY && env.FORCE_COLOR === undefined && env.NO_COLOR === undefined) env.FORCE_COLOR = '1';
    // The lib runs the tests of the Actors listed here, each on the build given, or on its default build without one
    env.ACTOR_BUILDS = JSON.stringify(actorBuilds);
    const described = actorBuilds.map(
        ({ actorFullName, actorRawId, buildNumber }) =>
            `${actorFullName ?? actorRawId} (${buildNumber ?? 'default build'})`,
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
        const report = toTestReport(vitestReport, { cwd, exitCode });
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
