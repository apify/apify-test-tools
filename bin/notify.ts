import fs from 'node:fs/promises';

import { notifiers } from './notifiers/index.js';
import type { NotifyPayload } from './notifiers/types.js';
import { readNotifiersConfig } from './utils.js';

interface NotifyOptions {
    notifyFile: string;
    notifier: string;
    target: string;
    dryRun: boolean;
}

export const notify = async ({ notifyFile, notifier: notifierName, target, dryRun }: NotifyOptions) => {
    const payload: NotifyPayload = JSON.parse((await fs.readFile(notifyFile)).toString());

    const notifier = notifiers[notifierName];
    if (!notifier) {
        throw new Error(
            `Unknown notifier "${notifierName}". Available notifiers: ${Object.keys(notifiers).join(', ')}.`,
        );
    }

    const notifiersConfig = await readNotifiersConfig();
    await notifier(payload, { target, dryRun, config: notifiersConfig?.[notifierName] });
};
