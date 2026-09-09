import { WebClient } from '@slack/web-api';

import { getEnvVar } from '../utils.js';
import { Notifier, type NotifierConfig } from './notifier.js';
import type { NotifierMessage, NotifyDocument } from './types.js';

export interface SlackNotifierConfig extends NotifierConfig {
    tokenEnvVar: string;
}

const LOGGED_DETAILS_LIMIT = 5;

export class SlackNotifier extends Notifier<SlackNotifierConfig> {
    assertConfig(config: unknown): SlackNotifierConfig {
        if (
            typeof config !== 'object' ||
            config === null ||
            typeof (config as Partial<SlackNotifierConfig>).tokenEnvVar !== 'string'
        ) {
            throw new Error(
                `Slack notifier requires a "notifiers.slack.tokenEnvVar" entry in the config file, pointing to the ` +
                    `env var holding the Slack bot token.`,
            );
        }
        return config as SlackNotifierConfig;
    }

    format(document: NotifyDocument, view?: 'dev' | 'public'): NotifierMessage | null {
        if (document.type === 'test-report') {
            return this.formatTestReport(document);
        }
        return this.formatReleaseReport(document, view);
    }

    private formatTestReport(document: Extract<NotifyDocument, { type: 'test-report' }>): NotifierMessage | null {
        const { failed, failedCount, totalCount, jobUrl, workflowName } = document;
        if (failed.length === 0) {
            return null;
        }

        const jobLink = jobUrl ? ` Check <${jobUrl}|the job>.` : '';
        let summary = `\`${workflowName ?? '-'}\``;
        summary += `: has ${failed.length} failed assertions. Failing test suites: ${failedCount}/${totalCount}.${jobLink}`;
        summary += `\n\n${failed[0].message} --- <${failed[0].runLink}|${failed[0].actorId}>`;
        const details = failed
            .slice(1)
            .map(({ message, runLink, actorId }) => `• ${message} --- <${runLink}|${actorId}>`);

        return { summary, details };
    }

    private formatReleaseReport(
        document: Extract<NotifyDocument, { type: 'release-report' }>,
        view?: 'dev' | 'public',
    ): NotifierMessage | null {
        const { repository, author, changelog, commits, changedFiles } = document;
        const shortSummary = `*${repository}* – New release (by ${author}):\n\n`;

        // Public copy only cares about user-facing changes, so there's nothing to say when the
        // changelog carries no entries.
        if (view === 'public') {
            return changelog ? { summary: `${shortSummary}*Additions to the changelog*:\n\n${changelog}\n` } : null;
        }

        // Dev copy is for devs and project managers who need the full picture: commits and files touched.
        const commitsMessage = commits
            .map(
                ({ author: commitAuthor, message }, index) =>
                    `${index + 1}. Commit message: ${message}\n\tAuthor: ${commitAuthor}.`,
            )
            .join('\n');
        const changedFilesMessage = `*Files changed*: ${changedFiles.map((file) => `\`${file}\``).join(', ')}`;

        return { summary: `${shortSummary}\n*Commit list*:\n${commitsMessage}\n\n${changedFilesMessage}` };
    }

    async send(
        message: NotifierMessage,
        { target, dryRun, config }: { target: string; dryRun: boolean; config: SlackNotifierConfig },
    ): Promise<void> {
        const { tokenEnvVar } = this.assertConfig(config);

        console.error(`=========================================`);
        console.error(`Sending Slack message to channel: ${target}.\n\n${message.summary}`);
        if (message.details && message.details.length > 0) {
            const remaining = message.details.length - LOGGED_DETAILS_LIMIT;
            const loggedDetails = message.details.slice(0, LOGGED_DETAILS_LIMIT);
            if (remaining > 0) {
                loggedDetails.push(`... and (${remaining}) more.`);
            }
            console.error(`\nIn the thread:\n${loggedDetails.join('\n')}`);
        }
        console.error(`=========================================`);

        if (dryRun) {
            return;
        }

        const slack = new WebClient(getEnvVar(tokenEnvVar));
        const { ts } = await slack.chat.postMessage({ text: message.summary, channel: target });

        if (message.details && message.details.length > 0 && ts) {
            await slack.chat.postMessage({
                channel: target,
                thread_ts: ts,
                blocks: message.details.map((detail) => ({
                    text: { type: 'mrkdwn', text: detail },
                    type: 'section',
                })),
            });
        }
    }
}
