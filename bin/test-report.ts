import fs from 'node:fs/promises';

import type { FailedTest, NotifyDocument } from './notifiers/types.js';

interface ReportTestResultsOptions {
    input: string;
    output?: string;
    dryRun: boolean;
    jobUrl?: string;
    workflowName?: string;
}

export const reportTestResults = async ({ dryRun, input, output, jobUrl, workflowName }: ReportTestResultsOptions) => {
    const results: JsonTestResults = JSON.parse((await fs.readFile(input)).toString());
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

    const failedTests: FailedTest[] = [];

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
            // Every message flattened out of this assertion identifies the same failing assertion,
            // so they all share the id computed from it.
            const id = `${meta.actorId} > ${fullName}`;
            failedTests.push(
                ...failureMessages.map((message) => ({
                    id,
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

    const document: NotifyDocument = {
        type: 'test-report',
        workflowName,
        jobUrl,
        failed: failedTests,
        failedCount: failed.length,
        passedCount: passed.length,
        totalCount: passed.length + failed.length,
    };

    if (dryRun) {
        console.error(JSON.stringify(document));
        return;
    }

    console.log(JSON.stringify(document));

    if (output) {
        await fs.writeFile(output, JSON.stringify(document));
    }
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
