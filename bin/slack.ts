import { WebClient } from '@slack/web-api';
import { Commit } from './types';
import { getEnvVar } from './utils.js';

type NotifyToSlackOptions = {
    repository: string
    changedFiles: string[]
    changelog: string | null
    commits: Commit[]
    dryRun: boolean
    author: string
}

export const notifyToSlack = async ({
    changedFiles,
    commits,
    changelog,
    repository,
    dryRun,
    author
}: NotifyToSlackOptions) => {
    const slack = new WebClient(getEnvVar('SLACK_TOKEN_RELEASES_BOT'));

    if (!changelog) {
        console.warn('No new changelog entries found, did you forget to update it?');
    }

    let shortMessage = `${repository} --- New release (by ${author}):\n\n`;

    // This one is just for broader public that only cares about public facing changes
    if (changelog) {
        console.error(`=========================================`);
        shortMessage += `**Additions to the changelog**:\n\n${changelog}\n`;
        const channel = '#delivery-public-actors';
        console.error(`**Sending slack message to channel**: ${channel}.\n\n${shortMessage}`);
        console.error(`=========================================`);
        if (!dryRun) {
            await slack.chat.postMessage({
                channel,
                text: shortMessage,
            });
        }
    }

    const commitsMessage = `${commits.map(({ author, message }, index) => `${index + 1}. Commit message: ${message}\n\tAuthor: ${author}.`).join('\n')}`;
    const changedFilesMessage = `**Files changed**: ${changedFiles.join(', ')}`;
    const longMessage = `${shortMessage}\n**Commit list**:\n${commitsMessage}\n\n${changedFilesMessage}`;

    // This one is for devs and project managers that need to know more details
    const notifChannel = `#notif-${repository.toLowerCase()}`;
    console.error(`=========================================`);
    console.error(`Sending slack message to channel: ${notifChannel}.\n\n${longMessage}`);
    console.error(`=========================================`);
    if (!dryRun) {
        await slack.chat.postMessage({
            text: longMessage,
            channel: notifChannel,
        });
    }
};

export const sendSlackMessage = async (
    channel: string,
    text: string,
    blocks: string[],
    token: string,
) => {
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
