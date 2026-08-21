import fs from 'node:fs/promises';

import type { NotifyPayload } from './notifiers/types.js';
import type { Commit } from './types.js';

interface WriteReleaseNotifyFilesOptions {
    repository: string;
    changedFiles: string[];
    changelog: string | null;
    commits: Commit[];
    dryRun: boolean;
    author: string;
    reportNotifyFile: string;
    releaseNotifyFile: string;
}

export const writeReleaseNotifyFiles = async ({
    changedFiles,
    commits,
    changelog,
    repository,
    dryRun,
    author,
    reportNotifyFile,
    releaseNotifyFile,
}: WriteReleaseNotifyFilesOptions) => {
    if (!changelog) {
        console.warn('No new changelog entries found, did you forget to update it?');
    }

    const shortSummary = `*${repository}* – New release (by ${author}):\n\n`;

    // This one is just for broader public that only cares about public facing changes
    const releasePayload: NotifyPayload = changelog
        ? { summary: `${shortSummary}*Additions to the changelog*:\n\n${changelog}\n` }
        : null;

    const commitsMessage = `${commits
        .map(
            ({ author: commitAuthor, message }, index) =>
                `${index + 1}. Commit message: ${message}\n\tAuthor: ${commitAuthor}.`,
        )
        .join('\n')}`;
    const changedFilesMessage = `*Files changed*: ${changedFiles.map((file) => `\`${file}\``).join(', ')}`;

    // This one is for devs and project managers that need to know more details
    const reportPayload: NotifyPayload = {
        summary: `${shortSummary}\n*Commit list*:\n${commitsMessage}\n\n${changedFilesMessage}`,
    };

    console.error('NOTIFY (report):', JSON.stringify(reportPayload));
    console.error('NOTIFY (release):', JSON.stringify(releasePayload));

    if (dryRun) {
        return;
    }

    await fs.writeFile(reportNotifyFile, JSON.stringify(reportPayload));
    await fs.writeFile(releaseNotifyFile, JSON.stringify(releasePayload));
};
