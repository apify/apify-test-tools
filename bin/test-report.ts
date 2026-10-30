import path from 'node:path';

import { logger } from './logger.js';

export type TestStatus = 'passed' | 'failed' | 'skipped';

/** The Actor run a test started, as the lib records it on the test's `meta`. */
export interface TestRun {
    actorId: string;
    runId: string;
    runLink: string;
}

export interface TestCaseReport {
    /** The full test name, including its `describe` blocks, e.g. `owner/name: finishes` */
    name: string;
    /** Relative to the directory the tests ran in */
    file: string;
    status: TestStatus;
    durationMs: number | null;
    /** The first line of each failure, the rest (diffs, stack traces) is in the vitest output */
    failureMessages: string[];
    /** Null for tests that didn't start a run: skipped ones, standby tests, or ones that failed before the run */
    run: TestRun | null;
}

/**
 * What `test` writes to stdout and `notify` reads. A contract between the CLI and whoever reads it, so add fields
 * freely, but renaming or removing one needs a new `version`.
 */
export interface TestReport {
    version: 1;
    /** False if any test failed, or the run failed in a way no test accounts for (see `errors`) */
    success: boolean;
    summary: { total: number; passed: number; failed: number; skipped: number };
    tests: TestCaseReport[];
    /** Failures outside any test, e.g. a test file that failed to import, or vitest crashing without a report */
    errors: string[];
}

// Vitest's JSON reporter output, only the parts we read
type VitestStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'todo' | 'disabled';

interface VitestAssertionResult {
    fullName: string;
    status: VitestStatus;
    duration?: number | null;
    failureMessages: string[] | null;
    meta?: Partial<TestRun>;
}

interface VitestFileResult {
    name: string;
    status: 'failed' | 'passed';
    message: string;
    assertionResults: VitestAssertionResult[];
}

export interface VitestJsonReport {
    success: boolean;
    testResults: VitestFileResult[];
}

const firstLine = (text: string) => text.split('\n')[0];

const toRun = (meta: Partial<TestRun> | undefined): TestRun | null => {
    const { actorId, runId, runLink } = meta ?? {};
    return actorId && runId && runLink ? { actorId, runId, runLink } : null;
};

/**
 * Turns vitest's JSON report into a `TestReport`. `exitCode` is vitest's: a non-zero exit with every test passing
 * still fails the report (e.g. an unhandled error between tests), so the report never reads greener than the run.
 */
export const toTestReport = (
    vitest: VitestJsonReport,
    { cwd, exitCode }: { cwd: string; exitCode: number },
): TestReport => {
    const tests: TestCaseReport[] = [];
    const errors: string[] = [];

    for (const file of vitest.testResults) {
        const relativeFile = path.relative(cwd, file.name);
        // A file that fails to load (an import error, a syntax error) has no tests to blame, only its message
        if (file.status === 'failed' && file.message) {
            errors.push(`${relativeFile}: ${firstLine(file.message)}`);
        }
        for (const assertion of file.assertionResults) {
            const status: TestStatus =
                assertion.status === 'passed' || assertion.status === 'failed' ? assertion.status : 'skipped';
            tests.push({
                name: assertion.fullName,
                file: relativeFile,
                status,
                durationMs: assertion.duration != null ? Math.round(assertion.duration) : null,
                failureMessages: (assertion.failureMessages ?? []).map(firstLine),
                run: toRun(assertion.meta),
            });
        }
    }

    const count = (status: TestStatus) => tests.filter((test) => test.status === status).length;
    const summary = {
        total: tests.length,
        passed: count('passed'),
        failed: count('failed'),
        skipped: count('skipped'),
    };
    if (exitCode !== 0 && summary.failed === 0 && errors.length === 0) {
        errors.push(`Vitest exited with code ${exitCode}, see its output above`);
    }

    return {
        version: 1,
        success: vitest.success && exitCode === 0 && summary.failed === 0 && errors.length === 0,
        summary,
        tests,
        errors,
    };
};

/** The report of a run that left no vitest report behind, e.g. because vitest crashed or was killed. */
export const failedRunReport = (error: string): TestReport => ({
    version: 1,
    success: false,
    summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
    tests: [],
    errors: [error],
});

/** Logs the tests with their run links, which vitest's own output doesn't show. */
export const logTestReport = ({ summary, tests, errors }: TestReport) => {
    const runLink = ({ run }: TestCaseReport) => (run ? ` ... ${run.runLink}` : '');
    const totals = `PASSED: ${summary.passed}, FAILED: ${summary.failed}, SKIPPED: ${summary.skipped}`;

    logger.info();
    logger.info(totals);
    for (const status of ['passed', 'failed'] as const) {
        const matching = tests.filter((test) => test.status === status);
        if (matching.length === 0) continue;
        logger.info();
        logger.info(status === 'passed' ? 'Passed:' : 'Failed:');
        for (const [i, test] of matching.entries()) {
            logger.info(`${i + 1}) ${test.name}${runLink(test)}`);
            for (const message of test.failureMessages) logger.info(`    ${message}`);
        }
    }
    if (errors.length > 0) {
        logger.info();
        logger.info('Errors outside of tests:');
        for (const error of errors) logger.info(`- ${error}`);
    }
    logger.info();
    logger.info(totals);
};
