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

export interface BuildData {
    buildId: string;
    actorRawId: string;
    actorFullName: string;
    buildNumber: string;
}

export interface ActorConfig {
    actorFullName: string;
    folder: string;
    tokenEnvVar: string;
    dockerContextDir: string;
    contextPaths: string[];
}
