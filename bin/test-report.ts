import fs from 'fs/promises';
import { sendSlackMessage } from './slack.js';
import { getEnvVar } from './utils.js';

interface ReportTestRestulsOptions {
    reportFile: string
    dryRun: boolean
    jobUrl?: string
    repository?: string
    workflowName?: string
}

export const reportTestRestuls = async ({
    dryRun,
    reportFile: jsonResultsPath,
    jobUrl,
    workflowName,
    repository,
}: ReportTestRestulsOptions) => {
    const results: JsonTestResults = JSON.parse((await fs.readFile(jsonResultsPath)).toString());
    const passed: JsonAssertionResult[] = [];
    const failed: JsonAssertionResult[] = [];
    let failedAssertions = 0;

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

    const failedAssertionss: string[] = [];

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
        const { failureMessages, fullName } = aResult;
        if (failureMessages) {
            failedAssertions += failureMessages.length;
        }
        console.error(`${i + 1}) ${fullName} ... ${aResult.meta.runLink}`);
        console.error();
    }
    console.error();
    console.error(`PASSED: ${passed.length}, FAILED: ${failed.length}`);
    console.error();

    if (failedAssertions === 0) {
        return;
    }

    // TODO: add slack profiles
    const total = failed.length + passed.length;
    const jobLink = jobUrl ? ` Check <${jobUrl}|the job>.` : '';
    let slackMessage = `\`${workflowName ?? '-'}\`: *${repository ?? '-'}*`;
    slackMessage += `: has ${failedAssertions} failed assertions. Failing test suites: ${failed.length}/${total}.${jobLink}`;
    slackMessage += `\n\n${failedAssertionss[0]}`;
    const blocks = failedAssertionss.slice(1);
    console.error('SLACK:', slackMessage);
    console.error('  blocks:', blocks.join('\n'));

    if (!dryRun) {
        const slackToken = getEnvVar('SLACK_TOKEN_TESTS_BOT');
        const channel = `#notif-${repository}`;
        await sendSlackMessage(channel, slackMessage, blocks, slackToken);
    }
};

type Status = 'passed' | 'failed' | 'skipped' | 'pending' | 'todo' | 'disabled'
type Milliseconds = number
interface Callsite {
    line: number
    column: number
}

interface JsonAssertionResult {
    ancestorTitles: Array<string>
    fullName: string
    status: Status
    title: string
    meta: {
        runId: string
        runLink: string
    }
    duration?: Milliseconds | null
    failureMessages: Array<string> | null
    location?: Callsite | null
}

interface JsonTestResult {
    message: string
    name: string
    status: 'failed' | 'passed'
    startTime: number
    endTime: number
    assertionResults: Array<JsonAssertionResult>
    // summary: string
    // coverage: unknown
}

interface JsonTestResults {
    numFailedTests: number
    numFailedTestSuites: number
    numPassedTests: number
    numPassedTestSuites: number
    numPendingTests: number
    numPendingTestSuites: number
    numTodoTests: number
    numTotalTests: number
    numTotalTestSuites: number
    startTime: number
    success: boolean
    testResults: Array<JsonTestResult>
    // snapshot: SnapshotSummary
    // coverageMap?: CoverageMap | null | undefined
    // numRuntimeErrorTestSuites: number
    // wasInterrupted: boolean
}
