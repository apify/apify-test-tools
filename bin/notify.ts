import { getCommitUrl, getRepoName, resolveRepoUrl } from './git.js';
import { logger } from './logger.js';
import { getSlackClient, sendingLabel, sendSlackMessage } from './slack.js';
import type { NotifyInput, ReleaseChanges } from './stdin-input.js';
import type { TestCaseReport, TestReport } from './test-report.js';

export const notifyOnChoices = ['failure', 'always'] as const;
type NotifyOn = (typeof notifyOnChoices)[number];

interface Message {
    text: string;
    /** Posted in the message's thread, so a long list keeps the channel readable */
    details: string[];
}

/**
 * A place a notification goes, one per `notify` call: a caller with more places calls `notify` once for each. A
 * target checks its credentials when it is created, before we know whether there is anything to send, so a broken
 * token shows up on a green run (and in dry runs) rather than on the day tests fail. Slack is the only one for now;
 * another (e.g. email) is one more factory next to `createSlackTarget`.
 */
interface NotificationTarget {
    send(message: Message): Promise<void>;
}

const SLACK_TOKEN_ENV_VAR = 'SLACK_BOT_TOKEN';

// Long enough for any sensible commit title, short enough that one runaway title doesn't swamp the message
const MAX_COMMIT_TITLE_LENGTH = 200;

interface NotifyOptions {
    input: NotifyInput;
    slackChannel?: string;
    /** Tests only */
    on: NotifyOn;
    /** Tests only: what the message calls the run, e.g. the CI workflow name */
    title?: string;
    /** Tests only: link to the CI job, included in the message */
    jobUrl?: string;
    /** Releases only, names the release. Defaults to the `origin` remote, see resolveRepoUrl */
    repoUrl?: string;
    dryRun: boolean;
}

/** Tells the target about what is on stdin: a test run (the output of `test`) or a release (of `get-affected-actors`). */
export const notify = async (options: NotifyOptions) => {
    assertFlagsFitInput(options);
    const { input, slackChannel, dryRun } = options;
    // A target is created only once we know a message may go out, so a release with no commits needs no token
    const createTarget = async () => {
        if (!slackChannel) {
            logger.info('Skipping notification, no --slack-channel passed');
            return null;
        }
        return createSlackTarget(SLACK_TOKEN_ENV_VAR, slackChannel, dryRun);
    };
    if (input.kind === 'tests') {
        await notifyTestReport({ ...options, report: input.report, createTarget });
    } else {
        await notifyRelease({ ...options, changes: input.changes, createTarget });
    }
};

/** A flag the input has no use for would be dropped silently, so it fails instead: the caller meant something by it. */
const assertFlagsFitInput = ({ input, on, title, jobUrl, repoUrl }: NotifyOptions) => {
    const misfits =
        input.kind === 'tests'
            ? [repoUrl && '--repo-url']
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

type CreateTarget = () => Promise<NotificationTarget | null>;

/** How a test run went: by default only when it failed, with `on: 'always'` always. */
const notifyTestReport = async ({
    report,
    on,
    title,
    jobUrl,
    createTarget,
}: Pick<NotifyOptions, 'on' | 'title' | 'jobUrl'> & { report: TestReport; createTarget: CreateTarget }) => {
    const target = await createTarget();
    if (!target) return;
    if (report.success && on === 'failure') {
        logger.info('The tests passed, so there is nothing to notify about (pass --on always to notify anyway)');
        return;
    }

    await target.send(formatTestMessage({ report, title: title ?? '-', jobUrl }));
};

/**
 * What a release changed: its changelog additions, then its commits, each linked to its commit page. Posts nothing
 * when there are no commits, which means there is nothing new to release.
 */
const notifyRelease = async ({
    changes: { commits, changelog },
    repoUrl,
    createTarget,
}: Pick<NotifyOptions, 'repoUrl'> & { changes: ReleaseChanges; createTarget: CreateTarget }) => {
    if (commits.length === 0) {
        logger.info('No new commits, so there is no release to announce');
        return;
    }
    if (!changelog) {
        logger.warn('No new changelog entries found, did you forget to update it?');
    }
    const target = await createTarget();
    if (!target) return;

    const resolvedRepoUrl = (await resolveRepoUrl(repoUrl)).repoUrl;
    await target.send({ text: formatReleaseMessage({ commits, changelog }, resolvedRepoUrl), details: [] });
};

/** The release, named after the repository and the author of its newest commit, the pushed head. */
export const formatReleaseMessage = ({ commits, changelog }: ReleaseChanges, repoUrl: string) => {
    const { author } = commits[commits.length - 1];
    let text = `*${getRepoName(repoUrl)}* – New release (by ${displayName(author)}):\n\n`;
    if (changelog) text += `${changelog.trim()}\n\n`;
    text += '*Commits*:\n';
    text += commits
        .map(({ sha, author: commitAuthor, message }, index) => {
            const title =
                message.length > MAX_COMMIT_TITLE_LENGTH
                    ? `${message.slice(0, MAX_COMMIT_TITLE_LENGTH - 1)}…`
                    : message;
            const url = getCommitUrl(repoUrl, sha);
            const linked = url ? `<${url}|${escapeSlack(title)}>` : escapeSlack(title);
            return `${index + 1}. ${linked} – ${displayName(commitAuthor)}`;
        })
        .join('\n');
    return text;
};

// Git authors come as "Name<email>", Slack only needs the name
const displayName = (author: string) => author.replace(/\s*<[^>]*>$/, '');

const createSlackTarget = async (
    tokenEnvVar: string,
    channel: string,
    dryRun: boolean,
): Promise<NotificationTarget> => {
    const slack = await getSlackClient(tokenEnvVar, dryRun);
    return {
        async send({ text, details }) {
            logger.info(`${sendingLabel(dryRun)} slack message to channel ${channel}:\n${text}`);
            if (details.length > 0) logger.info(`\tin its thread:\n\t${details.join('\n\t')}`);
            if (!dryRun) await sendSlackMessage(slack, channel, text, details);
        },
    };
};

// Slack reads these as markup, so they have to be escaped wherever text comes from the tests
const escapeSlack = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One line per failure message, linked to the run that failed, if the test started one. */
const formatFailures = ({ failureMessages, run }: TestCaseReport) => {
    const link = run ? ` --- <${run.runLink}|${escapeSlack(run.actorId)}>` : '';
    return failureMessages.map((message) => `${escapeSlack(message)}${link}`);
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
    const { total, failed, passed } = report.summary;
    const failedAssertions = report.tests.filter(({ status }) => status === 'failed').flatMap(formatFailures);
    const failures = [...failedAssertions, ...report.errors.map((error) => `Error: ${escapeSlack(error)}`)];
    const jobLink = jobUrl ? ` Check <${jobUrl}|the job>.` : '';

    let text = `\`${escapeSlack(title)}\``;
    if (report.success) {
        text += `: all ${passed} tests passed.${jobLink}`;
        return { text, details: [] };
    }
    text += `: has ${failedAssertions.length} failed assertions. Failing test suites: ${failed}/${total}.`;
    if (report.errors.length > 0) text += ` Errors outside of tests: ${report.errors.length}.`;
    text += jobLink;
    if (failures.length > 0) text += `\n\n${failures[0]}`;
    return { text, details: failures.slice(1).map((failure) => `• ${failure}`) };
};
