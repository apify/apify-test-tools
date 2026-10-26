import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { logger } from './logger.js';
import { failedRunReport, logTestReport, type TestReport, toTestReport, type VitestJsonReport } from './test-report.js';
import type { BuildData } from './types.js';

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

/** Platform tests mostly wait on Actor runs, not on the CPU, so they run far more at once than vitest's defaults. */
const PARALLELISM_ARGS = ['--maxConcurrency=20', '--fileParallelism', '--maxWorkers=100'];

/** Whether `args` set the option of `arg` themselves; vitest rejects an option given twice. */
const overrides = (args: string[], arg: string) => {
    const name = arg.replace(/^--/, '').split('=')[0];
    return args.some((a) => [`--${name}`, `--no-${name}`].includes(a.split('=')[0]));
};

interface RunTestsOptions {
    /** Vitest file filters, e.g. `test/platform/core` */
    filters: string[];
    /** The builds to test, from `build`. Null runs the tests of every Actor against its default build. */
    builds: BuildData[] | null;
    /** Keeps vitest's own JSON report there, e.g. to upload it */
    vitestOutputFile?: string;
    /** Passed to vitest as they are, after the ones we set */
    vitestArgs: string[];
    cwd?: string;
}

/**
 * Runs the repository's vitest on the given builds and returns what happened as a `TestReport`. Vitest's own output
 * goes to stderr, so stdout stays free for the report. A failing test or a crashing vitest is a failed report, not
 * an error: the report is how the failure gets to `notify`.
 */
export const runTests = async ({
    filters,
    builds,
    vitestOutputFile,
    vitestArgs,
    cwd = process.cwd(),
}: RunTestsOptions): Promise<TestReport> => {
    const vitestBin = await resolveVitestBin(cwd);
    if (!process.env.TESTER_APIFY_TOKEN) {
        logger.warn('TESTER_APIFY_TOKEN is not set, so the lib skips every platform test');
    }

    const tempDir = vitestOutputFile ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'apify-test-tools-'));
    const outputFile = path.resolve(cwd, vitestOutputFile ?? path.join(tempDir!, 'vitest-report.json'));
    // A report left over from an earlier run must not pass for this one's
    await fs.rm(outputFile, { force: true });

    // Stdin is the only source of builds, so whatever the caller's environment holds doesn't leak into the tests
    const env = { ...process.env };
    delete env.ACTOR_BUILDS;
    delete env.RUN_ALL_PLATFORM_TESTS;
    if (builds) {
        env.ACTOR_BUILDS = JSON.stringify(builds);
        logger.info(`Testing ${builds.length} build(s): ${builds.map((b) => b.actorFullName).join(', ') || 'none'}`);
    } else {
        env.RUN_ALL_PLATFORM_TESTS = '1';
        logger.info("Testing every Actor's default build");
    }

    const args = [
        vitestBin,
        'run',
        ...filters,
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${outputFile}`,
        ...PARALLELISM_ARGS.filter((arg) => !overrides(vitestArgs, arg)),
        ...vitestArgs,
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
        // Vitest's stdout goes to our stderr: stdout is reserved for the report
        const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 2, 2] });
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
