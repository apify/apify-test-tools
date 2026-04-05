import fs from 'node:fs/promises';

import { sendSlackMessage } from './slack.js';
import { getEnvVar } from './utils.js';

interface ReportTestResultsOptions {
    reportFile: string;
    dryRun: boolean;
    reportSlackChannel?: string;
    jobUrl?: string;
    workflowName?: string;
}

export const reportTestResults = async ({
    dryRun,
    reportSlackChannel,
    reportFile: jsonResultsPath,
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

    const failedAssertions: {
        message: string;
        runLink: string;
        actorName: string;
        alerts: JsonAssertionResult['meta']['alerts'];
    }[] = [];

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
                    actorName: meta.actorName,
                    alerts: meta.alerts,
                })),
            );
        }
        console.error(`${i + 1}) ${fullName} ... ${meta.runLink}`);
        console.error();
    }
    console.error();
    console.error(`PASSED: ${passed.length}, FAILED: ${failed.length}`);
    console.error();

    if (!reportSlackChannel) {
        console.error(
            `Skipping slack notification. If you want to enable it, add --report-slack-channel flag and make sure SLACK_TOKEN_TESTS_BOT env variable is set.`,
        );
        return;
    }

    const slackAssertions = failedAssertions.filter(({ alerts }) => shouldNotifySlack(alerts));

    if (slackAssertions.length === 0) {
        return;
    }

    // TODO: add slack profiles
    const total = failed.length + passed.length;
    const jobLink = jobUrl ? ` Check <${jobUrl}|the job>.` : '';
    let slackMessage = `\`${workflowName ?? '-'}\``;
    slackMessage += `: has ${slackAssertions.length} failed assertions. Failing test suites: ${failed.length}/${total}.${jobLink}`;
    slackMessage += `\n\n${slackAssertions[0].message} --- <${slackAssertions[0].runLink}|${slackAssertions[0].actorName}>`;
    const blocks = slackAssertions
        .slice(1)
        .map(({ message, runLink, actorName }) => `• ${message} --- <${runLink}|${actorName}>`);

    console.error('SLACK:', slackMessage);
    console.error('\tblocks:', blocks.join('\n\t\t'));

    if (!dryRun) {
        const slackToken = getEnvVar('SLACK_TOKEN_TESTS_BOT');
        await sendSlackMessage(reportSlackChannel, slackMessage, blocks, slackToken);
    }
};

/**
 * Returns `true` when a failing test should trigger a Slack notification.
 * - `alerts` not set → notify (backward-compatible default).
 * - `alerts.slack === false` → suppressed.
 * - `alerts.slack === true` (or any other value) → notify.
 *
 * Exported for unit testing.
 */
export function shouldNotifySlack(alerts: { slack?: boolean } | undefined): boolean {
    return alerts?.slack !== false;
}

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
        actorName: string;
        /**
         * Alerting config set by the test via `alerts` in `testActor`/`describe`.
         * `undefined` means the test didn't opt in or out — treat as "notify" for
         * backward compatibility.
         * `slack: false` explicitly disables the Slack notification for that test.
         */
        alerts?: { slack?: boolean };
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
