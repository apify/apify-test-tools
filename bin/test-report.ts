import fs from 'node:fs/promises';

import { logger } from './logger.js';
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

    const failedAssertions: { message: string; runLink: string; actorId: string }[] = [];

    logger.info();
    logger.info(`PASSED: ${passed.length}, FAILED: ${failed.length}`);
    logger.info();
    logger.info('**************************************************');
    logger.info('*                   Successes                    *');
    logger.info('**************************************************');
    logger.info();
    for (const [i, aResult] of passed.entries()) {
        const { fullName } = aResult;
        logger.info(`${i + 1}) ${fullName} ... ${aResult.meta.runLink}`);
        logger.info();
    }

    logger.info('**************************************************');
    logger.info('*                   Failures                     *');
    logger.info('**************************************************');
    logger.info();
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
        logger.info(`${i + 1}) ${fullName} ... ${meta.runLink}`);
        logger.info();
    }
    logger.info();
    logger.info(`PASSED: ${passed.length}, FAILED: ${failed.length}`);
    logger.info();

    if (!reportSlackChannel) {
        logger.info(
            `Skipping slack notification. If you want to enable it, add --report-slack-channel flag and make sure SLACK_TOKEN_TESTS_BOT env variable is set.`,
        );
        return;
    }

    if (failedAssertions.length === 0) {
        return;
    }

    // TODO: add slack profiles
    const total = failed.length + passed.length;
    const jobLink = jobUrl ? ` Check <${jobUrl}|the job>.` : '';
    let slackMessage = `\`${workflowName ?? '-'}\``;
    slackMessage += `: has ${failedAssertions.length} failed assertions. Failing test suites: ${failed.length}/${total}.${jobLink}`;
    slackMessage += `\n\n${failedAssertions[0].message} --- <${failedAssertions[0].runLink}|${failedAssertions[0].actorId}>`;
    const blocks = failedAssertions
        .slice(1)
        .map(({ message, runLink, actorId }) => `• ${message} --- <${runLink}|${actorId}>`);

    logger.info('SLACK:', slackMessage);
    logger.info('\tblocks:', blocks.join('\n\t\t'));

    if (!reportSlackChannel) {
        return;
    }

    if (!dryRun) {
        const slackToken = getEnvVar('SLACK_TOKEN_TESTS_BOT');
        await sendSlackMessage(reportSlackChannel, slackMessage, blocks, slackToken);
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
