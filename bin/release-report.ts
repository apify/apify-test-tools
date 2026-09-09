import fs from 'node:fs/promises';

import type { NotifyDocument } from './notifiers/types.js';
import type { Commit } from './types.js';

interface WriteReleaseDocumentOptions {
    repository: string;
    changedFiles: string[];
    changelog: string | null;
    commits: Commit[];
    dryRun: boolean;
    author: string;
    output?: string;
}

export const writeReleaseDocument = async ({
    changedFiles,
    commits,
    changelog,
    repository,
    dryRun,
    author,
    output,
}: WriteReleaseDocumentOptions) => {
    if (!changelog) {
        console.warn('No new changelog entries found, did you forget to update it?');
    }

    const document: NotifyDocument = {
        type: 'release-report',
        repository,
        author,
        changelog,
        commits,
        changedFiles,
    };

    if (dryRun) {
        console.error(JSON.stringify(document));
        return;
    }

    console.log(JSON.stringify(document));

    if (output) {
        await fs.writeFile(output, JSON.stringify(document));
    }
};
