import fs from 'node:fs/promises';

import type { NotifyFileContents } from './notifiers/types.js';

interface ReportTestResultsOptions {
    reportFile: string;
    notifyFile: string;
    dryRun: boolean;
    jobUrl?: string;
    workflowName?: string;
}

export const reportTestResults = async ({
    dryRun,
    reportFile: jsonResultsPath,
    notifyFile,
    jobUrl,
    workflowName,
}: ReportTestResultsOptions) => {
    const results: JsonTestResults = JSON.parse((await fs.readFile(jsonResultsPath)).toString());
    const passed: JsonAssertionResult[] = [];
    const failed: JsonAssertionResult[] = [];

    for (const result of results.testResults) {
        if (result.status !== 'failed') {
            passed.push(...result.assertionResults);
            continue;
        }
        for (const aResult of result.assertionResults) {
            if (aResult.status !== 'failed') {
                passed.push(aResult);
            } else {
                failed.push(aResult);
            }
        }
    }

    const failedAssertions: { message: string; runLink: string; actorId: string }[] = [];

    console.error();
    console.error(`PASSED: ${passed.length}, FAILED: ${failed.length}`);
    console.error();
    console.error('**************************************************');
    console.error('*                   Successes                    *');
    console.error('**************************************************');
    console.error();
    for (const [i, aResult] of passed.entries()) {
        const { fullName } = aResult;
        console.error(`${i + 1}) ${fullName} ... ${aResult.meta.runLink}`);
        console.error();
    }

    console.error('**************************************************');
    console.error('*                   Failures                     *');
    console.error('**************************************************');
    console.error();
    for (const [i, aResult] of failed.entries()) {
        const { failureMessages, fullName, meta } = aResult;
        if (failureMessages) {
            failedAssertions.push(
                ...failureMessages.map((message) => ({
                    message: message.split('\n')?.[0],
                    runLink: meta.runLink,
                    actorId: meta.actorId,
                })),
            );
        }
        console.error(`${i + 1}) ${fullName} ... ${meta.runLink}`);
        console.error();
    }
    console.error();
    console.error(`PASSED: ${passed.length}, FAILED: ${failed.length}`);
    console.error();

    let notifyPayload: NotifyFileContents = null;

    if (failedAssertions.length > 0) {
        // TODO: add slack profiles
        const total = failed.length + passed.length;
        const jobLink = jobUrl ? ` Check <${jobUrl}|the job>.` : '';
        let summary = `\`${workflowName ?? '-'}\``;
        summary += `: has ${failedAssertions.length} failed assertions. Failing test suites: ${failed.length}/${total}.${jobLink}`;
        summary += `\n\n${failedAssertions[0].message} --- <${failedAssertions[0].runLink}|${failedAssertions[0].actorId}>`;
        const details = failedAssertions
            .slice(1)
            .map(({ message, runLink, actorId }) => `• ${message} --- <${runLink}|${actorId}>`);

        notifyPayload = { summary, details };
    }

    console.error('NOTIFY:', JSON.stringify(notifyPayload));

    if (dryRun) {
        return;
    }

    await fs.writeFile(notifyFile, JSON.stringify(notifyPayload));
};

type Status = 'passed' | 'failed' | 'skipped' | 'pending' | 'todo' | 'disabled';
type Milliseconds = number;
interface Callsite {
    line: number;
    column: number;
}

interface JsonAssertionResult {
    ancestorTitles: string[];
    fullName: string;
    status: Status;
    title: string;
    meta: {
        runId: string;
        runLink: string;
        actorId: string;
    };
    duration?: Milliseconds | null;
    failureMessages: string[] | null;
    location?: Callsite | null;
}

interface JsonTestResult {
    message: string;
    name: string;
    status: 'failed' | 'passed';
    startTime: number;
    endTime: number;
    assertionResults: JsonAssertionResult[];
    // summary: string
    // coverage: unknown
}

interface JsonTestResults {
    numFailedTests: number;
    numFailedTestSuites: number;
    numPassedTests: number;
    numPassedTestSuites: number;
    numPendingTests: number;
    numPendingTestSuites: number;
    numTodoTests: number;
    numTotalTests: number;
    numTotalTestSuites: number;
    startTime: number;
    success: boolean;
    testResults: JsonTestResult[];
    // snapshot: SnapshotSummary
    // coverageMap?: CoverageMap | null | undefined
    // numRuntimeErrorTestSuites: number
    // wasInterrupted: boolean
}
