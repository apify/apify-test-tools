import { WebClient } from '@slack/web-api';
import { Commit } from './types';
import { getEnvVar } from './utils.js';

type NotifyToSlackOptions = {
    repository: string
    changedFiles: string[]
    changelog: string | null
    commits: Commit[]
    dryRun: boolean
}

export const notifyToSlack = async ({
    changedFiles,
    commits,
    changelog,
    repository,
    dryRun,
}: NotifyToSlackOptions) => {
    const slack = new WebClient(getEnvVar('SLACK_TOKEN_RELEASES_BOT'));

    if (!changelog) {
        console.warn('No new changelog entries found, haven\'t you forgotten to update it?');
    }

    let shortMessage = `${repository}: new release:\n`;

    // This one is just for broader public that only cares about public facing changes
    if (changelog) {
        console.error(`New changelog entries: ${changelog}`);
        shortMessage += `Changelog:\n\n${changelog}\n`;
        const channel = '#delivery-public-actors';
        console.error(`Sending slack message to channel: ${channel}. Message: ${shortMessage}`);
        if (!dryRun) {
            await slack.chat.postMessage({
                channel,
                text: shortMessage,
            });
        }
    }

    const commitsMessage = `${commits.map(({ author, message }, index) => `  ${index + 1} Commit message: ${message}\n  Author: ${author}.`).join('\n')}`;
    const changedFilesMessage = `Files changed: ${changedFiles.join(', ')}`;
    const longMessage = `${shortMessage}\nCommits:\n\n${commitsMessage}\n\n${changedFilesMessage}`;

    // This one is for devs and project managers that need to know more details
    const notifChannel = `#notif-${repository.toLowerCase()}`;
    console.error(`Sending slack message to channel: ${notifChannel}. Message: ${longMessage}`);
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
