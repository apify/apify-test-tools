import fs from 'node:fs/promises';

import { notifiers } from './notifiers/index.js';
import type { NotifyDocument, NotifyTargetKey } from './notifiers/types.js';
import { readNotifiersConfig } from './utils.js';

interface NotifyOptions {
    input?: string;
    notifier: string;
    view?: 'dev' | 'public';
    dryRun: boolean;
}

const readStdin = async (): Promise<string> => {
    const chunks: string[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk.toString());
    }
    return chunks.join('');
};

const KNOWN_DOCUMENT_TYPES: NotifyDocument['type'][] = ['test-report', 'release-report'];

// The document comes from external JSON (a file or stdin). This only validates the "type" discriminant
// at that boundary — it does not validate the rest of the document's shape.
const parseNotifyDocument = (raw: string): NotifyDocument => {
    const value = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || !KNOWN_DOCUMENT_TYPES.includes(value.type)) {
        throw new Error(
            `Malformed notify document: expected "type" to be one of ${KNOWN_DOCUMENT_TYPES.join(', ')}, got ${JSON.stringify(value?.type)}.`,
        );
    }
    return value;
};

export const notify = async ({ input, notifier: notifierName, view, dryRun }: NotifyOptions) => {
    const notifier = notifiers[notifierName];
    if (!notifier) {
        throw new Error(
            `Unknown notifier "${notifierName}". Available notifiers: ${Object.keys(notifiers).join(', ')}.`,
        );
    }

    // isTTY is true only for an interactive terminal, not a pipe/redirect, so this only fires when
    // there's genuinely no input source (no --input, nothing piped in) rather than hanging on stdin.
    if (!input && process.stdin.isTTY) {
        throw new Error('No document to read: no --input file given, and no data piped in on stdin.');
    }
    const raw = input ? (await fs.readFile(input)).toString() : await readStdin();
    const document = parseNotifyDocument(raw);

    if (document.type === 'release-report' && !view) {
        throw new Error('--view is required for release-report documents.');
    }
    const targetKey: NotifyTargetKey = (
        document.type === 'release-report' ? `release-report-${view}` : document.type
    ) as NotifyTargetKey;

    const message = notifier.format(document, view);
    if (!message) {
        console.error('Nothing to notify, skipping.');
        return;
    }

    const rawConfig = await readNotifiersConfig(notifierName);
    const config = notifier.assertConfig(rawConfig);

    // Targets aren't validated upfront, so `config.targets` may not match its type at runtime.
    const target = config.targets?.[targetKey];
    if (typeof target !== 'string') {
        throw new Error(
            `No target configured for notifier "${notifierName}". Add a "notifiers.${notifierName}.targets.${targetKey}" ` +
                `entry to the config file.`,
        );
    }

    await notifier.send(message, { target, dryRun, config });
};
