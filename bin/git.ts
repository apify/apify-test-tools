import { logger } from './logger.js';
import type { Commit, Config } from './types.js';
import { runGitCommand, spawnCommand } from './utils.js';

export const GIT_FORMAT_SEPARATOR = '»¦«';
const GIT_LOG_FORMAT = ['%H', '%aN<%aE>', '%aD', '%s'].join(GIT_FORMAT_SEPARATOR);

/**
 * Gets the list of changed files between the given commits (inclusive).
 */
export const getChangedFiles = async (commits: Commit[]) => {
    // getCommits never returns an empty list (the rerun check returns all commits when the base commit
    // is the branch HEAD, and an empty git range throws when parsing), so this signals a programmer error
    if (commits.length === 0) {
        throw new Error('Cannot get changed files: the commit list is empty. This should never happen.');
    }

    const changedFilesString = await runGitCommand([
        'diff',
        '--name-only',
        `${commits[0].sha}~..${commits[commits.length - 1].sha}`,
    ]);

    const changedFiles = changedFilesString.split('\n').filter(Boolean);
    logger.info(`Changed files (up to 50): ${changedFiles.slice(0, 50).join(', ')}`);
    return changedFiles;
};

/**
 * Returns true if the branch contains a merge commit whose parent is reachable from targetBranch
 * (i.e. a genuine "merge from target" commit, not a merge of some unrelated branch).
 * Uses the full targetBranch..sourceBranch range, ignoring baseCommit.
 */
export const hasMergeFromTarget = async (sourceBranch: string, targetBranch: string): Promise<boolean> => {
    const mergeShas = (
        await runGitCommand(['log', '--merges', '--pretty=format:%H', `${targetBranch}..${sourceBranch}`])
    )
        .split('\n')
        .filter(Boolean);

    for (const sha of mergeShas) {
        const parents = (await runGitCommand(['log', '-1', '--pretty=format:%P', sha])).split(' ');
        for (const parent of parents) {
            // git merge-base A B outputs the common ancestor.
            // If that equals A, then A is an ancestor of B (i.e. parent is reachable from targetBranch).
            let mergeBase: string;
            try {
                mergeBase = await runGitCommand(['merge-base', parent, targetBranch]);
            } catch (error) {
                // Exit code 1 means the histories have no common ancestor.
                if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
                    continue;
                }
                throw error;
            }
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
export const getBranchOnlyChangedFiles = async (sourceBranch: string, targetBranch: string): Promise<string[]> => {
    const output = await runGitCommand([
        'log',
        '--no-merges',
        '--name-only',
        '--pretty=format:',
        `${targetBranch}..${sourceBranch}`,
    ]);
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

const fetchAllBranchCommits = async (sourceBranch: string, targetBranch: string): Promise<Commit[]> => {
    const output = await runGitCommand([
        'log',
        `--pretty=format:${GIT_LOG_FORMAT}`,
        `${targetBranch}..${sourceBranch}`,
    ]);
    const commitsStrings = output.split('\n');
    const commits = commitsStrings.map((commitString) => parseCommit(commitString));
    commits.reverse();
    return commits;
};

/**
 * Gets the commits between sourceBranch and targetBranch (exclusive).
 * - If baseCommit is provided, only returns commits after the baseCommit.
 */
export const getCommits = async ({
    sourceBranch,
    targetBranch,
    baseCommit,
}: Pick<Config, 'sourceBranch' | 'targetBranch' | 'baseCommit'>): Promise<Commit[]> => {
    const baseCommitSha = parseBaseCommit(baseCommit);
    const commits = await fetchAllBranchCommits(sourceBranch, targetBranch);

    // The last validated (base) commit being the branch HEAD means nothing new was pushed since the last
    // validation — the dev reran the workflow (or force-pushed to the same state) to trigger a clean test
    const headSha = commits[commits.length - 1]?.sha;
    if (baseCommitSha !== undefined && baseCommitSha === headSha) {
        logger.info(
            `Detected rerun with the same commit that we already validated. This usually means the user wants to rerun the Action from scratch, ignoring last validated commit ${baseCommitSha} and returning all commits`,
        );
        logger.info(`Commits being returned: ${commits.map((c) => c.sha).join(', ')}`);
        return commits;
    }

    const baseCommitIndex = commits.findIndex((commit) => commit.sha === baseCommitSha);

    const hasBaseCommit = baseCommitIndex !== -1;
    if (hasBaseCommit) {
        const commitsUpToBaseCommit = commits.slice(baseCommitIndex + 1);
        logger.info(
            `Found base commit ${baseCommitSha} at index ${baseCommitIndex}, returning ${commitsUpToBaseCommit.length} commits after it`,
        );
        logger.info(`Commits being returned: ${commitsUpToBaseCommit.map((c) => c.sha).join(', ')}`);
        return commitsUpToBaseCommit;
    }

    logger.info(`Base commit ${baseCommitSha} not found in the commit range, returning all ${commits.length} commits`);
    logger.info(`Commits being returned: ${commits.map((c) => c.sha).join(', ')}`);
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
export const getCurrentBranch = async (): Promise<string> => {
    const branch = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
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
const getOriginRepoUrl = async (): Promise<string> => {
    const rawUrl = await runGitCommand(['remote', 'get-url', 'origin']);
    return rawUrl.replace(/^https:\/\/github\.com\//, 'git@github.com:');
};

/**
 * Picks the repo URL to build from. By default it's the `origin` remote, and runBuilds then checks it against
 * each Actor's default version, so a fork or mirror remote can't repoint a published Actor. An explicit
 * --repo-url skips that check: passing it is how you move an Actor to another repository on purpose.
 */
export const resolveRepoUrl = async (explicitRepoUrl: string | undefined) => ({
    repoUrl: explicitRepoUrl ?? (await getOriginRepoUrl()),
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
export const resolveReleaseBaseCommit = async (baseCommit: string): Promise<string> => {
    const sha = parseBaseCommit(baseCommit);
    if (!sha) {
        throw new Error('--base-commit is required for release. See the README section "Releasing Actors".');
    }
    if (ZERO_SHA_REGEX.test(sha)) {
        throw new Error(
            `Base commit is ${sha}, which means the branch was just created and there is no previous release to diff against. ` +
                `Rerun with --base-commit set to the last commit before the changes you want to release.`,
        );
    }
    const isMissingGitResult = (error: unknown): boolean =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === 1;

    // --quiet suppresses Git's error text for a missing commit, but Git still exits with code 1.
    const verifiedSha = await runGitCommand(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).catch(
        (error: unknown) => {
            if (isMissingGitResult(error)) return '';
            throw error;
        },
    );
    if (!verifiedSha) {
        throw new Error(
            `Base commit ${sha} is not in the local git history. Either the checkout is shallow ` +
                `(fetch the full history, e.g. fetch-depth: 0 in actions/checkout) or the branch was force-pushed.`,
        );
    }
    // git merge-base A B outputs the common ancestor. If that equals A, then A is an ancestor of B.
    const mergeBase = await runGitCommand(['merge-base', verifiedSha, 'HEAD']).catch((error: unknown) => {
        if (isMissingGitResult(error)) return '';
        throw error;
    });
    if (mergeBase !== sha) {
        throw new Error(
            `Base commit ${sha} is not an ancestor of HEAD, most likely because the branch was force-pushed. ` +
                `The changed files cannot be determined reliably. Rerun with --base-commit set to an ancestor of HEAD ` +
                `from before the changes you want to release.`,
        );
    }
    return sha;
};

const CHANGELOG_PATH = 'CHANGELOG.md';

/** Returns the lines added to the root CHANGELOG.md between baseSha and HEAD, or null if it didn't change. */
const getChangelogAdditions = async (baseSha: string, changedFiles: string[]): Promise<string | null> => {
    if (!changedFiles.includes(CHANGELOG_PATH)) {
        return null;
    }
    const diff = await runGitCommand(['diff', baseSha, 'HEAD', '--', CHANGELOG_PATH]);

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
export const getReleaseChanges = async (baseSha: string) => {
    if (spawnCommand('git rev-parse HEAD') === baseSha) {
        return null;
    }
    const commits = await fetchAllBranchCommits('HEAD', baseSha);
    const changedFiles = spawnCommand(`git diff --name-only ${baseSha} HEAD`).split('\n').filter(Boolean);
    const changelog = await getChangelogAdditions(baseSha, changedFiles);
    return { commits, changedFiles, changelog };
};
