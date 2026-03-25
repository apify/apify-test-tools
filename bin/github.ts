import fs from 'node:fs/promises';

import type { Commit, GitHubEventPush } from './types.js';
import { spawnCommandInGhWorkspace } from './utils.js';

export const getPushData = async (path: string) => {
    const event = await loadGitHubEvent(path);
    const branch = event.ref.replace('refs/heads/', '');
    const {
        commits: ghCommits,
        repository: { ssh_url: repoUrl, name },
        head_commit: { author },
    } = event;
    const commits: Commit[] = ghCommits.map(({ author: commitAuthor, message, id, timestamp }) => ({
        author: commitAuthor.username,
        sha: id,
        message,
        date: timestamp,
    }));
    const changedFiles = getChangedFiles(event);
    const changelog = getChangelogChanges(changedFiles, event);
    return {
        branch,
        commits,
        changedFiles,
        repoUrl,
        changelog,
        repository: name,
        author: author.name,
    };
};

const loadGitHubEvent = async (path: string): Promise<GitHubEventPush> => {
    const pushEvent = JSON.parse((await fs.readFile(path)).toString()) as GitHubEventPush;
    return pushEvent;
};

const getChangedFiles = ({ after, before }: GitHubEventPush): string[] => {
    const changedFiles = spawnCommandInGhWorkspace(`git diff --name-only ${after}..${before}`);
    return changedFiles.split('\n');
};

const getChangelogChanges = (changedFiles: string[], event: GitHubEventPush): string | null => {
    const changelogPath = 'CHANGELOG.md';
    if (!changedFiles.includes(changelogPath)) {
        return null;
    }
    const { after, before } = event;
    const diff = spawnCommandInGhWorkspace('git', ['diff', before, after, '--', changelogPath]);

    const added: string[] = [];
    let startedChangelog = false;
    for (const line of diff.split('\n')) {
        // We should already get only files we care about from getLastCommitDiffForFile but better to double check
        if (line.startsWith('+++') && line.toLowerCase().includes(changelogPath.toLowerCase())) {
            startedChangelog = true;
            continue;
        }
        if (startedChangelog) {
            if (line.startsWith('diff')) {
                break;
            }
            if (line.startsWith('+')) {
                added.push(line.slice(1).trim());
            }
        }
    }
    return added.join('\n').trim();
};
