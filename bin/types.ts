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

/**
 * What a dry run writes to stdout instead of the command's real result. It's an object, not an array, so
 * it can't be mistaken for real builds: `ACTOR_BUILDS` rejects it before any test runs.
 */
export interface DryRunPlan<T> {
    dryRun: true;
    builds: T[];
}

export interface ActorConfig {
    actorFullName: string;
    folder: ExistingDir;
    tokenEnvVar: string;
    actorJson: ActorJsonPaths;
    dockerContextDir: RelativeDir;
    contextPaths: RelativeDir[];
}
