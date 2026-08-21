import fs from 'node:fs/promises';

import { notifiers } from './notifiers/index.js';
import type { NotifyFileContents } from './notifiers/types.js';
import { readNotifiersConfig } from './utils.js';

interface NotifyOptions {
    notifyFile: string;
    notifier: string;
    target: string;
    dryRun: boolean;
    tokenEnvVar?: string;
}

export const notify = async ({ notifyFile, notifier: notifierName, target, dryRun, tokenEnvVar }: NotifyOptions) => {
    const payload: NotifyFileContents = JSON.parse((await fs.readFile(notifyFile)).toString());

    const notifier = notifiers[notifierName];
    if (!notifier) {
        throw new Error(
            `Unknown notifier "${notifierName}". Available notifiers: ${Object.keys(notifiers).join(', ')}.`,
        );
    }

    if (!payload) {
        console.error('Nothing to notify, skipping.');
        return;
    }

    // An explicit --token-env-var skips the config file check entirely.
    const config = tokenEnvVar ? { tokenEnvVar } : (await readNotifiersConfig())?.[notifierName];
    await notifier(payload, { target, dryRun, config });
};
