import { WebClient } from '@slack/web-api';

import { logger } from './logger.js';
import type { Commit } from './types.js';
import { getEnvVar } from './utils.js';

type NotifyToSlackOptions = {
    repository: string;
    changedFiles: string[];
    changelog: string | null;
    commits: Commit[];
    dryRun: boolean;
    author: string;
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

export const notifyToSlack = async ({
    changedFiles,
    commits,
    changelog,
    repository,
    dryRun,
    author,
    releaseSlackChannel,
    reportSlackChannel,
}: NotifyToSlackOptions) => {
    if (!changelog) {
        logger.warn('No new changelog entries found, did you forget to update it?');
    }

    if (!releaseSlackChannel && !reportSlackChannel) {
        logger.info('Skipping slack notification, no --release-slack-channel or --report-slack-channel passed');
        return;
    }
    const slack = await getSlackClient('SLACK_TOKEN_RELEASES_BOT', dryRun);

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

export const sendSlackMessage = async (slack: WebClient, channel: string, text: string, blocks: string[]) => {
    const { ts } = await slack.chat.postMessage({ text, channel });
    if (blocks.length > 0 && ts) {
        await slack.chat.postMessage({
            channel,
            thread_ts: ts,
            blocks: blocks.map((t) => ({ text: { type: 'mrkdwn', text: t }, type: 'section' })),
        });
    }
};
