import { WebClient } from '@slack/web-api';

import { logger } from './logger.js';
import { getEnvVar } from './utils.js';

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
