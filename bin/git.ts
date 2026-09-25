import type { Commit, Config } from './types.js';
import { spawnCommandInGhWorkspace } from './utils.js';

export const GIT_FORMAT_SEPARATOR = '»¦«';
const GIT_LOG_FORMAT = ['%H', '%aN<%aE>', '%aD', '%s'].join(GIT_FORMAT_SEPARATOR);

/**
 * Gets the list of changed files between the given commits (inclusive).
 */
export const getChangedFiles = (commits: Commit[]) => {
    // getCommits never returns an empty list (the rerun check returns all commits when the base commit
    // is the branch HEAD, and an empty git range throws when parsing), so this signals a programmer error
    if (commits.length === 0) {
        throw new Error('Cannot get changed files: the commit list is empty. This should never happen.');
    }

    const changedFilesString = spawnCommandInGhWorkspace(
        `git diff --name-only ${commits[0].sha}~..${commits[commits.length - 1].sha}`,
    );

    const changedFiles = changedFilesString.split('\n');
    console.error(`Changed files (up to 50): ${changedFiles.slice(0, 50).join(', ')}`);
    return changedFiles;
};

/**
 * Returns true if the branch contains a merge commit whose parent is reachable from targetBranch
 * (i.e. a genuine "merge from target" commit, not a merge of some unrelated branch).
 * Uses the full targetBranch..sourceBranch range, ignoring baseCommit.
 */
export const hasMergeFromTarget = (sourceBranch: string, targetBranch: string): boolean => {
    const mergeShas = spawnCommandInGhWorkspace(`git log --merges --pretty=format:%H ${targetBranch}..${sourceBranch}`)
        .split('\n')
        .filter(Boolean);

    for (const sha of mergeShas) {
        const parents = spawnCommandInGhWorkspace(`git log -1 --pretty=format:%P ${sha}`).trim().split(' ');
        for (const parent of parents) {
            // git merge-base A B outputs the common ancestor.
            // If that equals A, then A is an ancestor of B (i.e. parent is reachable from targetBranch).
            const mergeBase = spawnCommandInGhWorkspace(`git merge-base ${parent} ${targetBranch}`);
            if (mergeBase === parent) {
                return true;
            }
        }
    }
    return false;
};

/**
 * Returns all files touched by non-merge commits on the branch (full history, ignoring baseCommit).
 * Used to check whether the branch itself has any functional changes, independent of what master merged in.
 */
export const getBranchOnlyChangedFiles = (sourceBranch: string, targetBranch: string): string[] => {
    const output = spawnCommandInGhWorkspace(
        `git log --no-merges --name-only --pretty=format: ${targetBranch}..${sourceBranch}`,
    );
    return output.split('\n').filter(Boolean);
};

const SHA_REGEX = /^[0-9a-f]{40}$/i;

/**
 *
 * @param shaOrCommit Supports both a SHA string or a Commit object in JSON format. Can be empty.
 * @returns The SHA string if valid, otherwise throws an error.
 */
export const parseBaseCommit = (shaOrCommit: string | undefined): string | undefined => {
    if (!shaOrCommit) return undefined;
    let sha: string;
    if (shaOrCommit.startsWith('{')) {
        sha = (JSON.parse(shaOrCommit) as Commit).sha;
    } else {
        sha = shaOrCommit;
    }
    if (!SHA_REGEX.test(sha)) {
        throw new Error(
            `Invalid base commit SHA: "${sha}". It should be a 40-character hexadecimal string, instead got input: "${shaOrCommit}".`,
        );
    }
    return sha;
};

const fetchAllBranchCommits = (sourceBranch: string, targetBranch: string): Commit[] => {
    const commitsStrings = spawnCommandInGhWorkspace(
        `git log --pretty=format:'${GIT_LOG_FORMAT}' ${targetBranch}..${sourceBranch}`,
    ).split('\n');
    const commits = commitsStrings.map((commitString) => parseCommit(commitString));
    commits.reverse();
    return commits;
};

/**
 * Gets the commits between sourceBranch and targetBranch (exclusive).
 * - If baseCommit is provided, only returns commits after the baseCommit.
 */
export const getCommits = ({
    sourceBranch,
    targetBranch,
    baseCommit,
}: Pick<Config, 'sourceBranch' | 'targetBranch' | 'baseCommit'>): Commit[] => {
    const baseCommitSha = parseBaseCommit(baseCommit);
    const commits = fetchAllBranchCommits(sourceBranch, targetBranch);

    // The last validated (base) commit being the branch HEAD means nothing new was pushed since the last
    // validation — the dev reran the workflow (or force-pushed to the same state) to trigger a clean test
    const headSha = commits[commits.length - 1]?.sha;
    if (baseCommitSha !== undefined && baseCommitSha === headSha) {
        console.error(
            `Detected rerun with the same commit that we already validated. This usually means the user wants to rerun the Action from scratch, ignoring last validated commit ${baseCommitSha} and returning all commits`,
        );
        console.error(`Commits being returned: ${commits.map((c) => c.sha).join(', ')}`);
        return commits;
    }

    const baseCommitIndex = commits.findIndex((commit) => commit.sha === baseCommitSha);

    const hasBaseCommit = baseCommitIndex !== -1;
    if (hasBaseCommit) {
        const commitsUpToBaseCommit = commits.slice(baseCommitIndex + 1);
        console.error(
            `Found base commit ${baseCommitSha} at index ${baseCommitIndex}, returning ${commitsUpToBaseCommit.length} commits after it`,
        );
        console.error(`Commits being returned: ${commitsUpToBaseCommit.map((c) => c.sha).join(', ')}`);
        return commitsUpToBaseCommit;
    }

    console.error(
        `Base commit ${baseCommitSha} not found in the commit range, returning all ${commits.length} commits`,
    );
    console.error(`Commits being returned: ${commits.map((c) => c.sha).join(', ')}`);
    return commits;
};

export const parseCommit = (commitString: string): Commit => {
    const splits = commitString.split(GIT_FORMAT_SEPARATOR);
    if (splits.length !== 4) {
        throw new Error(`Failed to parse commit string: ${commitString}`);
    }
    const [sha, author, date, message] = splits;
    return {
        sha,
        author,
        date,
        message,
    };
};

/**
 * Returns the currently checked-out branch. Release builds point the Actor version at this branch,
 * so a detached HEAD (no branch to point at) is an error rather than a guess.
 */
export const getCurrentBranch = (): string => {
    const branch = spawnCommandInGhWorkspace('git rev-parse --abbrev-ref HEAD');
    if (branch === 'HEAD') {
        throw new Error(
            'Cannot determine the branch to release: HEAD is detached. Check out the branch you want to release.',
        );
    }
    return branch;
};

/**
 * Reads the repository URL from the `origin` remote, rewritten to the SSH form the Apify platform
 * uses for Git repo sources, e.g. git@github.com:apify-store/google-maps
 */
const getOriginRepoUrl = (): string => {
    return spawnCommandInGhWorkspace('git remote get-url origin').replace(
        /^https:\/\/github\.com\//,
        'git@github.com:',
    );
};

/**
 * Picks the repo URL to build from. By default it's the `origin` remote, and runBuilds then checks it against
 * each Actor's default version, so a fork or mirror remote can't repoint a published Actor. An explicit
 * --repo-url skips that check: passing it is how you move an Actor to another repository on purpose.
 */
export const resolveRepoUrl = (explicitRepoUrl: string | undefined) => ({
    repoUrl: explicitRepoUrl ?? getOriginRepoUrl(),
    shouldVerifyRepoUrl: explicitRepoUrl === undefined,
});

/**
 * Makes repo URLs comparable regardless of their form. All of these normalize to `github.com/org/repo`:
 * - git@github.com:org/repo.git
 * - https://github.com/org/repo
 * - ssh://git@github.com/org/repo#master:actors/foo (Actor versions carry a `#branch:folder` fragment)
 */
export const normalizeRepoUrl = (repoUrl: string): string => {
    return repoUrl
        .trim()
        .split('#')[0]
        .replace(/^[a-z+]+:\/\//i, '')
        .replace(/^[^@/]+@/, '')
        .replace(':', '/')
        .replace(/\/+$/, '')
        .replace(/\.git$/, '')
        .toLowerCase();
};

/** Repository name from its URL, e.g. `google-maps` for git@github.com:apify-store/google-maps.git */
export const getRepoName = (repoUrl: string): string => {
    return normalizeRepoUrl(repoUrl).split('/').pop()!;
};

// Sent by e.g. GitHub as the "before" commit of a push that created the branch
const ZERO_SHA_REGEX = /^0{40}$/;

/**
 * Validates the base commit of a release: the last commit whose changes are already released.
 * Unlike the PR path (getCommits), there is no lenient fallback. Falling back to "everything"
 * would rebuild the latest build of every Actor and post it to Slack, so every problem is an error.
 */
export const resolveReleaseBaseCommit = (baseCommit: string): string => {
    const sha = parseBaseCommit(baseCommit);
    if (!sha) {
        throw new Error('--base-commit is required for release. See the README section "Releasing Actors".');
    }
    if (ZERO_SHA_REGEX.test(sha)) {
        throw new Error(
            `Base commit is ${sha}, which means the branch was just created and there is no previous release to diff against. ` +
                `Release the Actors explicitly with --actors and --base-commit set to the commit before your changes.`,
        );
    }
    // --quiet makes rev-parse print nothing (instead of an error) when the commit is missing
    if (!spawnCommandInGhWorkspace(`git rev-parse --verify --quiet "${sha}^{commit}"`)) {
        throw new Error(
            `Base commit ${sha} is not in the local git history. Either the checkout is shallow ` +
                `(fetch the full history, e.g. fetch-depth: 0 in actions/checkout) or the branch was force-pushed.`,
        );
    }
    // git merge-base A B outputs the common ancestor. If that equals A, then A is an ancestor of B.
    if (spawnCommandInGhWorkspace(`git merge-base ${sha} HEAD`) !== sha) {
        throw new Error(
            `Base commit ${sha} is not an ancestor of HEAD, most likely because the branch was force-pushed. ` +
                `The changed files cannot be determined reliably, release the Actors explicitly with --actors.`,
        );
    }
    return sha;
};

const CHANGELOG_PATH = 'CHANGELOG.md';

/** Returns the lines added to the root CHANGELOG.md between baseSha and HEAD, or null if it didn't change. */
const getChangelogAdditions = (baseSha: string, changedFiles: string[]): string | null => {
    if (!changedFiles.includes(CHANGELOG_PATH)) {
        return null;
    }
    const diff = spawnCommandInGhWorkspace('git', ['diff', baseSha, 'HEAD', '--', CHANGELOG_PATH]);

    const added: string[] = [];
    let startedChangelog = false;
    for (const line of diff.split('\n')) {
        // The diff is already limited to the changelog but better to double check
        if (line.startsWith('+++') && line.toLowerCase().includes(CHANGELOG_PATH.toLowerCase())) {
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

/**
 * Everything that changed since the last release (baseSha, exclusive) up to HEAD, or null when there
 * are no new commits. Changed files come from diffing the range directly instead of from the commit
 * list: with a merge commit, the oldest commit of the merged branch can be older than baseSha, and
 * diffing from its parent would pull in already-released changes.
 */
export const getReleaseChanges = (baseSha: string) => {
    if (spawnCommandInGhWorkspace('git rev-parse HEAD') === baseSha) {
        return null;
    }
    const commits = fetchAllBranchCommits('HEAD', baseSha);
    const changedFiles = spawnCommandInGhWorkspace(`git diff --name-only ${baseSha} HEAD`).split('\n').filter(Boolean);
    const changelog = getChangelogAdditions(baseSha, changedFiles);
    return { commits, changedFiles, changelog };
};
