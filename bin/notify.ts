import process from 'node:process';

import { getRepoName, resolveRepoUrl } from './git.js';
import { logger } from './logger.js';
import { getSlackClient, sendingLabel, sendSlackMessage } from './slack.js';
import type { NotifyInput, ReleaseChanges } from './stdin-input.js';
import type { TestCaseReport, TestReport } from './test-report.js';

export const notifyOnChoices = ['failure', 'always'] as const;
type NotifyOn = (typeof notifyOnChoices)[number];

/** One message, and the channels it goes to. A notification can tell different audiences different things. */
interface Message {
    channels: string[];
    text: string;
    /** Posted in the message's thread, so a long list keeps the channel readable */
    details: string[];
}

/**
 * A place notifications go. Each target checks its credentials when it is created, before we know whether there is
 * anything to send, so a broken token shows up on a green run (and in dry runs) rather than on the day tests fail.
 * Slack is the only one for now; another (e.g. email) is one more factory next to `createSlackTarget`.
 */
interface NotificationTarget {
    send(messages: Message[]): Promise<void>;
}

const TESTS_SLACK_TOKEN_ENV_VAR = 'SLACK_TOKEN_TESTS_BOT';
const RELEASES_SLACK_TOKEN_ENV_VAR = 'SLACK_TOKEN_RELEASES_BOT';

interface NotifyOptions {
    input: NotifyInput;
    /** Tests: the report. Releases: the commits and changed files, for the developers */
    slackChannels: string[];
    /** Releases only: the changelog additions, for everyone else */
    slackChangelogChannels: string[];
    /** Tests only */
    on: NotifyOn;
    /** Tests only, defaults to the GitHub workflow name, see githubRunContext */
    title?: string;
    /** Tests only, defaults to the GitHub Actions run, see githubRunContext */
    jobUrl?: string;
    /** Releases only, names the release. Defaults to the `origin` remote, see resolveRepoUrl */
    repoUrl?: string;
    dryRun: boolean;
}

/** Tells the targets about what is on stdin: a test run (the output of `test`) or a release (of `get-affected-actors`). */
export const notify = async (options: NotifyOptions) => {
    assertFlagsFitInput(options);
    const slackChannels = options.slackChannels.filter(Boolean);
    const slackChangelogChannels = options.slackChangelogChannels.filter(Boolean);
    if (options.input.kind === 'tests') {
        await notifyTestReport({ ...options, report: options.input.report, slackChannels });
    } else {
        await notifyRelease({ ...options, changes: options.input.changes, slackChannels, slackChangelogChannels });
    }
};

/** A flag the input has no use for would be dropped silently, so it fails instead: the caller meant something by it. */
const assertFlagsFitInput = ({ input, slackChangelogChannels, on, title, jobUrl, repoUrl }: NotifyOptions) => {
    const misfits =
        input.kind === 'tests'
            ? [slackChangelogChannels.length > 0 && '--slack-changelog-channel', repoUrl && '--repo-url']
            : [on !== 'failure' && '--on', title && '--title', jobUrl && '--job-url'];
    const passed = misfits.filter(Boolean);
    if (passed.length > 0) {
        const what =
            input.kind === 'tests'
                ? 'a test report (the output of test)'
                : 'a release (the output of get-affected-actors)';
        throw new Error(`${passed.join(', ')} can't be used with ${what} on stdin`);
    }
};

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

/** How a test run went: by default only when it failed, with `on: 'always'` always. */
const notifyTestReport = async ({
    report,
    on,
    slackChannels,
    title,
    jobUrl,
    dryRun,
}: Pick<NotifyOptions, 'on' | 'slackChannels' | 'title' | 'jobUrl' | 'dryRun'> & { report: TestReport }) => {
    if (slackChannels.length === 0) {
        logger.info('Skipping notification, no --slack-channel passed');
        return;
    }
    const slack = await createSlackTarget(TESTS_SLACK_TOKEN_ENV_VAR, dryRun);
    if (report.success && on === 'failure') {
        logger.info('The tests passed, so there is nothing to notify about (pass --on always to notify anyway)');
        return;
    }

    const defaults = githubRunContext();
    const notification = { report, title: title ?? defaults.title ?? 'Tests', jobUrl: jobUrl ?? defaults.jobUrl };
    await slack.send([{ channels: slackChannels, ...formatTestMessage(notification) }]);
};

/**
 * What a release changed: the changelog additions to the changelog channels, and the commits and changed files to
 * the others. Posts nothing when there are no commits, which means there is nothing new to release.
 */
const notifyRelease = async ({
    changes: { commits, changedFiles, changelog },
    slackChannels,
    slackChangelogChannels,
    repoUrl,
    dryRun,
}: Pick<NotifyOptions, 'slackChannels' | 'slackChangelogChannels' | 'repoUrl' | 'dryRun'> & {
    changes: ReleaseChanges;
}) => {
    if (commits.length === 0) {
        logger.info('No new commits, so there is no release to announce');
        return;
    }
    if (!changelog) {
        logger.warn('No new changelog entries found, did you forget to update it?');
    }
    if (slackChannels.length === 0 && slackChangelogChannels.length === 0) {
        logger.info('Skipping notification, no --slack-channel or --slack-changelog-channel passed');
        return;
    }
    const slack = await createSlackTarget(RELEASES_SLACK_TOKEN_ENV_VAR, dryRun);

    const repository = getRepoName((await resolveRepoUrl(repoUrl)).repoUrl);
    // The newest commit, same as the pushed head commit
    const { author } = commits[commits.length - 1];
    let summary = `*${repository}* – New release (by ${displayName(author)}):\n\n`;
    // The changelog is for the broader public, who only care about public facing changes
    if (changelog && slackChangelogChannels.length > 0) summary += `*Additions to the changelog*:\n\n${changelog}\n`;

    const commitList = commits
        .map(
            ({ author: commitAuthor, message }, index) =>
                `${index + 1}. Commit message: ${message}\n\tAuthor: ${displayName(commitAuthor)}.`,
        )
        .join('\n');
    const changedFilesList = `*Files changed*: ${changedFiles.map((file) => `\`${file}\``).join(', ')}`;

    await slack.send([
        ...(changelog ? [{ channels: slackChangelogChannels, text: summary, details: [] }] : []),
        // The full report is for devs and project managers, who need the details too
        {
            channels: slackChannels,
            text: `${summary}\n*Commit list*:\n${commitList}\n\n${changedFilesList}`,
            details: [],
        },
    ]);
};

// Git authors come as "Name<email>", Slack only needs the name
const displayName = (author: string) => author.replace(/\s*<[^>]*>$/, '');

const createSlackTarget = async (tokenEnvVar: string, dryRun: boolean): Promise<NotificationTarget> => {
    const slack = await getSlackClient(tokenEnvVar, dryRun);
    return {
        async send(messages) {
            for (const { channels, text, details } of messages) {
                for (const channel of channels) {
                    logger.info(`${sendingLabel(dryRun)} slack message to channel ${channel}:\n${text}`);
                    if (details.length > 0) logger.info(`\tin its thread:\n\t${details.join('\n\t')}`);
                    if (!dryRun) await sendSlackMessage(slack, channel, text, details);
                }
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
export const formatTestMessage = ({
    report,
    title,
    jobUrl,
}: {
    report: TestReport;
    title: string;
    jobUrl?: string;
}) => {
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
