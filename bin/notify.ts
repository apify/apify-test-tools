import process from 'node:process';

import { logger } from './logger.js';
import { getSlackClient, sendingLabel, sendSlackMessage } from './slack.js';
import type { TestCaseReport, TestReport } from './test-report.js';

export const notifyOnChoices = ['failure', 'always'] as const;
type NotifyOn = (typeof notifyOnChoices)[number];

/** What every target is told about a test run. */
interface TestNotification {
    report: TestReport;
    title: string;
    jobUrl?: string;
}

/**
 * A place notifications go. Each target checks its credentials when it is created, before we know whether there is
 * anything to send, so a broken token shows up on a green run (and in dry runs) rather than on the day tests fail.
 * Slack is the only one for now; another (e.g. email) is one more factory in `createTargets`.
 */
interface NotificationTarget {
    send(notification: TestNotification): Promise<void>;
}

const SLACK_TOKEN_ENV_VAR = 'SLACK_TOKEN_TESTS_BOT';

interface NotifyTestReportOptions {
    report: TestReport;
    on: NotifyOn;
    slackChannels: string[];
    /** Defaults to the GitHub workflow name, see githubRunContext */
    title?: string;
    /** Defaults to the GitHub Actions run, see githubRunContext */
    jobUrl?: string;
    dryRun: boolean;
}

/** Where a notification sent from GitHub Actions points by default: the workflow and the run it came from. */
export const githubRunContext = (env: NodeJS.ProcessEnv = process.env) => {
    const { GITHUB_WORKFLOW, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
    return {
        title: GITHUB_WORKFLOW || undefined,
        jobUrl:
            GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
                ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
                : undefined,
    };
};

/** Tells every configured target how a test run went: by default only when it failed, with `on: 'always'` always. */
export const notifyTestReport = async ({
    report,
    on,
    slackChannels,
    title,
    jobUrl,
    dryRun,
}: NotifyTestReportOptions) => {
    const targets = await createTargets({ slackChannels, dryRun });
    if (targets.length === 0) {
        logger.info('Skipping notification, no --slack-channel passed');
        return;
    }
    if (report.success && on === 'failure') {
        logger.info('The tests passed, so there is nothing to notify about (pass --on always to notify anyway)');
        return;
    }

    const defaults = githubRunContext();
    const notification = { report, title: title ?? defaults.title ?? 'Tests', jobUrl: jobUrl ?? defaults.jobUrl };
    for (const target of targets) {
        await target.send(notification);
    }
};

const createTargets = async ({ slackChannels, dryRun }: { slackChannels: string[]; dryRun: boolean }) => {
    const targets: NotificationTarget[] = [];
    const channels = slackChannels.filter(Boolean);
    if (channels.length > 0) targets.push(await createSlackTarget(channels, dryRun));
    return targets;
};

const createSlackTarget = async (channels: string[], dryRun: boolean): Promise<NotificationTarget> => {
    const slack = await getSlackClient(SLACK_TOKEN_ENV_VAR, dryRun);
    return {
        async send(notification) {
            const { text, details } = formatSlackMessage(notification);
            for (const channel of channels) {
                logger.info(`${sendingLabel(dryRun)} slack message to channel ${channel}:\n${text}`);
                if (details.length > 0) logger.info(`\tin its thread:\n\t${details.join('\n\t')}`);
                if (!dryRun) await sendSlackMessage(slack, channel, text, details);
            }
        },
    };
};

// Slack reads these as markup, so they have to be escaped wherever text comes from the tests
const escapeSlack = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const formatFailure = ({ name, failureMessages, run }: TestCaseReport) => {
    const link = run ? ` --- <${run.runLink}|${escapeSlack(run.actorId)}>` : '';
    const messages = failureMessages.length > 0 ? failureMessages : ['Failed without a message'];
    return messages.map((message) => `*${escapeSlack(name)}*: ${escapeSlack(message)}${link}`);
};

/**
 * The message is the outcome and the first failure; the other failures go to its thread, so a channel with many
 * failing runs stays readable.
 */
export const formatSlackMessage = ({ report, title, jobUrl }: TestNotification) => {
    const { passed, failed, skipped } = report.summary;
    const ran = passed + failed;
    const failures = [
        ...report.tests.filter(({ status }) => status === 'failed').flatMap(formatFailure),
        ...report.errors.map((error) => `*Error*: ${escapeSlack(error)}`),
    ];

    let outcome: string;
    if (failed > 0) {
        outcome = `${failed} of ${ran} tests failed.`;
    } else if (!report.success) {
        outcome = 'the tests failed to run.';
    } else {
        outcome = ran > 0 ? `all ${ran} tests passed.` : `no tests ran (${skipped} skipped).`;
    }
    if (report.errors.length > 0 && failed > 0) outcome += ` ${report.errors.length} error(s) outside of tests.`;
    const jobLink = jobUrl ? ` Check <${jobUrl}|the job>.` : '';

    let text = `\`${escapeSlack(title)}\`: ${outcome}${jobLink}`;
    if (failures.length > 0) text += `\n\n${failures[0]}`;
    return { text, details: failures.slice(1).map((failure) => `• ${failure}`) };
};
