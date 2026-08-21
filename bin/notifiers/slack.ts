import { WebClient } from '@slack/web-api';

import { getEnvVar } from '../utils.js';
import type { Notifier } from './types.js';

interface SlackNotifierConfig {
    tokenEnvVar: string;
}

const LOGGED_DETAILS_LIMIT = 5;

const assertSlackConfig = (config: unknown): SlackNotifierConfig => {
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
};

export const slackNotifier: Notifier = async (payload, { target, dryRun, config }) => {
    if (!payload) {
        console.error('Nothing to notify, skipping Slack message.');
        return;
    }

    const { tokenEnvVar } = assertSlackConfig(config);

    console.error(`=========================================`);
    console.error(`Sending Slack message to channel: ${target}.\n\n${payload.summary}`);
    if (payload.details && payload.details.length > 0) {
        const remaining = payload.details.length - LOGGED_DETAILS_LIMIT;
        const loggedDetails = payload.details.slice(0, LOGGED_DETAILS_LIMIT);
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
    const { ts } = await slack.chat.postMessage({ text: payload.summary, channel: target });

    if (payload.details && payload.details.length > 0 && ts) {
        await slack.chat.postMessage({
            channel: target,
            thread_ts: ts,
            blocks: payload.details.map((detail) => ({ text: { type: 'mrkdwn', text: detail }, type: 'section' })),
        });
    }
};
