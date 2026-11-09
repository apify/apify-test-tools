import type { ActorJsonPaths } from './utils/config/actor-json.js';
import type { ExistingDir, RelativeDir } from './utils/path/repo-relative.js';

/** The changes from `fromRef` (excluded) to `toRef`, compared as trees like `git diff fromRef toRef`. */
export interface GitRange {
    fromRef: string;
    toRef: string;
}

export type Commit = {
    sha: string;
    author: string;
    date: string;
    message: string;
};

/**
 * A build that already exists and can run an Actor's tests instead of a new one: `default` for the Actor's default
 * build, or a build of the branch that an earlier PR run made.
 */
export type ExistingBuild = 'default' | Omit<BuildData, 'actorFullName'>;

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
