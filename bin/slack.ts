import { WebClient } from '@slack/web-api';

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
    const slack = new WebClient(getEnvVar('SLACK_TOKEN_RELEASES_BOT'));

    if (!changelog) {
        console.warn('No new changelog entries found, did you forget to update it?');
    }

    let shortMessage = `${repository} --- New release (by ${author}):\n\n`;

    // This one is just for broader public that only cares about public facing changes
    if (changelog && releaseSlackChannel) {
        shortMessage += `**Additions to the changelog**:\n\n${changelog}\n`;
        console.error(`=========================================`);
        console.error(`**Sending slack message to channel**: ${releaseSlackChannel}.\n\n${shortMessage}`);
        console.error(`=========================================`);
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
                `${index + 1}. Commit message: ${message}\n\tAuthor: ${commitAuthor}.`,
        )
        .join('\n')}`;
    const changedFilesMessage = `**Files changed**: ${changedFiles.join(', ')}`;
    const longMessage = `${shortMessage}\n**Commit list**:\n${commitsMessage}\n\n${changedFilesMessage}`;

    // This one is for devs and project managers that need to know more details
    if (reportSlackChannel) {
        console.error(`=========================================`);
        console.error(`Sending slack message to channel: ${reportSlackChannel}.\n\n${longMessage}`);
        console.error(`=========================================`);
        if (!dryRun) {
            await slack.chat.postMessage({
                text: longMessage,
                channel: reportSlackChannel,
            });
        }
    }
};

export const sendSlackMessage = async (channel: string, text: string, blocks: string[], token: string) => {
    const slack = new WebClient(token);
    const { ts } = await slack.chat.postMessage({ text, channel });
    if (blocks.length > 0 && ts) {
        await slack.chat.postMessage({
            channel,
            thread_ts: ts,
            blocks: blocks.map((t) => ({ text: { type: 'mrkdwn', text: t }, type: 'section' })),
        });
    }
};
