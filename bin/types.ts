export interface Config {
    targetBranch: string;
    sourceBranch: string;
    baseCommit?: string;
    workspace?: string;
    actors: string[];
    ignore: string[];
}

export type Commit = {
    sha: string;
    author: string;
    date: string;
    message: string;
};

// NOTE: The GitHub types are incomplete, feel free to add fields/complete (not sure how stable GitHub API is)
export interface GitHubHeadCommit {
    added: string[];
    removed: string[];
    modified: string[];
    author: {
        name: string;
    };
    message: string;
    id: string;
}

export interface Repository {
    full_name: string;
    name: string;
    ssh_url: string;
    owner: {
        login: string;
    };
}

export type GitHubEvent = GitHubEventPullRequest | GitHubEventPush;

export interface GitHubEventPullRequest {
    // Type is our own variable we inject to have discriminated union
    // The rest of the properties are raw from GitHub API
    type: 'pull_request';
    pull_request: {
        number: number;
        base: {
            ref: string;
            sha: string;
        };
        head: {
            ref: string;
            sha: string;
        };
    };
    repository: Repository;
}

export interface GitHubEventPush {
    type: 'push';
    head_commit: GitHubHeadCommit;
    repository: Repository;
    ref: string;
    commits: GithubCommit[];
    before: string;
    after: string;
}

export interface GithubCommit {
    id: string;
    tree_id: string;
    distinct: boolean;
    message: string;
    timestamp: string;
    url: string;
    author: {
        name: string;
        email: string;
        username: string;
    };
    committer: {
        name: string;
        email: string;
        username: string;
    };
    added: string[];
    removed: string[];
    modified: string[];
}

// An actor's permanent identity, shared by its actors[] declaration and its resolved config
export interface ActorIdentity {
    folder: string;
    actorFullName: string;
}

// Known optional settings an actor can have, whether declared directly or filled in via configs
export interface ActorSettings {
    tokenEnvVar?: string;
    overrideActorContext?: string[];
}

// One actors[] entry
export type ActorDeclaration = ActorIdentity & ActorSettings;

// The matcher inside a configs[] entry: at least one of folder/actorFullName, both allowed together
export type ActorGlobMatch = { folder: string; actorFullName?: string } | { folder?: string; actorFullName: string };

// One configs[] entry
export interface ActorGlobConfigEntry {
    match: ActorGlobMatch;
    set: Record<string, unknown>;
}

// The top-level shape of the config file
export interface ConfigFileSchema {
    actors: ActorDeclaration[];
    configs?: ActorGlobConfigEntry[];
}

export interface BuildData {
    buildId: string;
    actorRawId: string;
    actorFullName: string;
    buildNumber: string;
}

// The fully resolved, merged actor config
export interface ActorConfig extends ActorIdentity {
    tokenEnvVar: string;
    dockerContextDir: string;
    contextPaths: string[];
}
