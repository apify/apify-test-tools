import { slackNotifier } from './slack.js';
import type { Notifier } from './types.js';

export const notifiers: Record<string, Notifier> = {
    slack: slackNotifier,
};
