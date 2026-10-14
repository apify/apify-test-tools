import { WebClient } from '@slack/web-api';

import { getRepoName, resolveRepoUrl } from './git.js';
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
    const slack = new WebClient(getEnvVar('SLACK_TOKEN_RELEASES_BOT'));

    if (!changelog) {
        logger.warn('No new changelog entries found, did you forget to update it?');
    }

    let shortMessage = `*${repository}* – New release (by ${displayName(author)}):\n\n`;

    // This one is just for broader public that only cares about public facing changes
    if (changelog && releaseSlackChannel) {
        shortMessage += `*Additions to the changelog*:\n\n${changelog}\n`;
        logger.info(`=========================================`);
        logger.info(`**Sending slack message to channel**: ${releaseSlackChannel}.\n\n${shortMessage}`);
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
        logger.info(`Sending slack message to channel: ${reportSlackChannel}.\n\n${longMessage}`);
        logger.info(`=========================================`);
        if (!dryRun) {
            await slack.chat.postMessage({
                text: longMessage,
                channel: reportSlackChannel,
            });
        }
    }
};

type AnnounceReleaseOptions = Omit<NotifyToSlackOptions, 'author' | 'repository'> & {
    // Defaults to the `origin` remote, see resolveRepoUrl
    repoUrl?: string;
};

/**
 * Posts what a release changed: its commits, changed files and changelog, as get-affected-actors reports them.
 * Posts nothing when there are no commits, which means there is nothing new to release.
 */
export const announceRelease = async ({ commits, repoUrl, ...options }: AnnounceReleaseOptions) => {
    if (commits.length === 0) {
        logger.info('No new commits, so there is no release to announce');
        return;
    }
    await notifyToSlack({
        ...options,
        commits,
        repository: getRepoName((await resolveRepoUrl(repoUrl)).repoUrl),
        // The newest commit, same as the pushed head commit
        author: commits[commits.length - 1].author,
    });
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
