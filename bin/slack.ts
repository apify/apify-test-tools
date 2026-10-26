import { WebClient } from '@slack/web-api';

import { getRepoName, resolveRepoUrl } from './git.js';
import { logger } from './logger.js';
import type { Commit } from './types.js';
import { getEnvVar } from './utils.js';

type NotifyToSlackOptions = {
    changedFiles: string[];
    changelog: string | null;
    commits: Commit[];
    // Defaults to the `origin` remote, see resolveRepoUrl
    repoUrl?: string;
    dryRun: boolean;
    releaseSlackChannel?: string;
    reportSlackChannel?: string;
};

/**
 * Creates the client the real run posts with. A dry run posts nothing but still requires the token and checks
 * Slack accepts it (`auth.test` is read-only), so it fails wherever the real run would.
 */
export const getSlackClient = async (tokenEnvVar: string, dryRun: boolean): Promise<WebClient> => {
    const slack = new WebClient(getEnvVar(tokenEnvVar));
    if (dryRun) {
        try {
            await slack.auth.test();
        } catch (err) {
            throw new Error(`${tokenEnvVar} was rejected by Slack: ${(err as Error).message}`);
        }
        logger.info(`[DRY RUN] ${tokenEnvVar} is valid`);
    }
    return slack;
};

export const sendingLabel = (dryRun: boolean) => (dryRun ? '[DRY RUN] Would send' : 'Sending');

// Git authors come as "Name<email>", Slack only needs the name
const displayName = (author: string) => author.replace(/\s*<[^>]*>$/, '');

/**
 * Posts what a release changed: its commits, changed files and changelog, as get-affected-actors reports them.
 * Posts nothing when there are no commits, which means there is nothing new to release.
 */
export const notifyToSlack = async ({
    changedFiles,
    commits,
    changelog,
    repoUrl,
    dryRun,
    releaseSlackChannel,
    reportSlackChannel,
}: NotifyToSlackOptions) => {
    if (commits.length === 0) {
        logger.info('No new commits, so there is no release to announce');
        return;
    }
    if (!changelog) {
        logger.warn('No new changelog entries found, did you forget to update it?');
    }

    if (!releaseSlackChannel && !reportSlackChannel) {
        logger.info('Skipping slack notification, no --release-slack-channel or --report-slack-channel passed');
        return;
    }
    const slack = await getSlackClient('SLACK_TOKEN_RELEASES_BOT', dryRun);

    const repository = getRepoName((await resolveRepoUrl(repoUrl)).repoUrl);
    // The newest commit, same as the pushed head commit
    const { author } = commits[commits.length - 1];
    let shortMessage = `*${repository}* – New release (by ${displayName(author)}):\n\n`;

    // This one is just for broader public that only cares about public facing changes
    if (changelog && releaseSlackChannel) {
        shortMessage += `*Additions to the changelog*:\n\n${changelog}\n`;
        logger.info(`=========================================`);
        logger.info(`**${sendingLabel(dryRun)} slack message to channel**: ${releaseSlackChannel}.\n\n${shortMessage}`);
        logger.info(`=========================================`);
        if (!dryRun) {
            await slack.chat.postMessage({
                channel: releaseSlackChannel,
                text: shortMessage,
            });
        }
    }

    const commitsMessage = `${commits
        .map(
            ({ author: commitAuthor, message }, index) =>
                `${index + 1}. Commit message: ${message}\n\tAuthor: ${displayName(commitAuthor)}.`,
        )
        .join('\n')}`;
    const changedFilesMessage = `*Files changed*: ${changedFiles.map((file) => `\`${file}\``).join(', ')}`;
    const longMessage = `${shortMessage}\n*Commit list*:\n${commitsMessage}\n\n${changedFilesMessage}`;

    // This one is for devs and project managers that need to know more details
    if (reportSlackChannel) {
        logger.info(`=========================================`);
        logger.info(`${sendingLabel(dryRun)} slack message to channel: ${reportSlackChannel}.\n\n${longMessage}`);
        logger.info(`=========================================`);
        if (!dryRun) {
            await slack.chat.postMessage({
                text: longMessage,
                channel: reportSlackChannel,
            });
        }
    }
};

// Slack's limits: 50 blocks per message, 3000 characters per section
const MAX_BLOCKS_PER_MESSAGE = 50;
const MAX_SECTION_LENGTH = 3000;

/** Posts `text`, with `details` as sections in its thread, as many replies as Slack's block limit needs. */
export const sendSlackMessage = async (slack: WebClient, channel: string, text: string, details: string[]) => {
    const { ts } = await slack.chat.postMessage({ text, channel });
    if (!ts) return;
    for (let i = 0; i < details.length; i += MAX_BLOCKS_PER_MESSAGE) {
        const sections = details.slice(i, i + MAX_BLOCKS_PER_MESSAGE);
        await slack.chat.postMessage({
            channel,
            thread_ts: ts,
            text: sections.join('\n').slice(0, MAX_SECTION_LENGTH),
            blocks: sections.map((t) => ({
                text: {
                    type: 'mrkdwn',
                    text: t.length > MAX_SECTION_LENGTH ? `${t.slice(0, MAX_SECTION_LENGTH - 1)}…` : t,
                },
                type: 'section',
            })),
        });
    }
};
