import type { Notifier } from './notifier.js';
import { SlackNotifier } from './slack.js';

export const notifiers: Record<string, Notifier> = {
    slack: new SlackNotifier(),
};
