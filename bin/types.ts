import type { ActorJsonPaths } from './utils/config/actor-json.js';
import type { ExistingDir, RelativeDir } from './utils/path/repo-relative.js';

export interface Config {
    targetBranch: string;
    sourceBranch: string;
    baseCommit?: string;
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
    folder: ExistingDir;
    tokenEnvVar: string;
    actorJson: ActorJsonPaths;
    dockerContextDir: RelativeDir;
    contextPaths: RelativeDir[];
}
