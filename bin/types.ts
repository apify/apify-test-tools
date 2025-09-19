export interface Config {
    targetBranch: string
    sourceBranch: string
    baseCommit?: string
    workspace?: string
}

export type Commit = {
    sha: string
    author: string
    date: string
    message: string
}

// NOTE: The GitHub types are incomplete, feel free to add fields/complete (not sure how stable GitHub API is)
export interface GitHubHeadCommit {
    added: string[]
    removed: string[]
    modified: string[],
    author: {
        name: string
    },
    message: string,
    id: string,
}

export interface Repository {
    full_name: string
    name: string
    ssh_url: string
    owner: {
        login: string
    }
}

export type GitHubEvent = GitHubEventPullRequest | GitHubEventPush;

// All optional type so we check that we have all required fields for each event type
export type RawGitHubEvent = Partial<Omit<GitHubEventPullRequest, 'type'> & Omit<GitHubEventPush, 'type'>>;

export interface GitHubEventPullRequest {
    // Type is our own variable we inject to have discriminated union
    // The rest of the properties are raw from GitHub API
    type: 'pull_request',
    pull_request: {
        number: number
        base: {
            ref: string,
            sha: string
        }
        head: {
            ref: string
            sha: string
        }
    }
    repository: Repository,
}

export interface GitHubEventPush {
    type: 'push',
    head_commit: GitHubHeadCommit,
    repository: Repository,
    ref: string
    commits: GithubCommit[]
    before: string
    after: string
}

export interface GithubCommit {
    id: string
    tree_id: string
    distinct: boolean
    message: string
    timestamp: string
    url: string
    author: {
        name: string
        email: string
        username: string
    }
    committer: {
        name: string
        email: string
        username: string
    }
    added: string[]
    removed: string[]
    modified: string[]
}

export interface BuildData {
    buildId: string;
    actorId: string;
    actorName: string;
    // folder: string | undefined;
    buildNumber: string;
}

export interface ActorConfig {
    actorName: string;
    folder: string;
    isStandalone: boolean
}
