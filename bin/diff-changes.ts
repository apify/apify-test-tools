import { isCosmeticOnlyJsonSchemaChange } from './diff-json-schema.js';
import { type DockerIgnoreMatcher, loadDockerIgnore } from './dockerignore.js';
import { logger } from './logger.js';
import type { ActorConfig, Commit } from './types.js';
import { type RelativeDir, RelativeFile } from './utils/path/repo-relative.js';

interface ShouldBuildAndTestOptions {
    filepathsChanged: string[];
    actorConfigs: ActorConfig[];
    isLatest?: boolean;
    commits: Commit[];
}

const IGNORED_TOP_LEVEL_FILES = [
    '.vscode/',
    '.gitignore',
    '.husky/',
    '.eslintrc',
    'eslint.config.mjs',
    '.prettierrc',
    '.editorconfig',
];

const isIgnoredTopLevelFile = (filePath: RelativeFile, contextPath: RelativeDir): boolean => {
    const pathWithinContext = contextPath.relativePathTo(filePath.path).toLowerCase();
    return IGNORED_TOP_LEVEL_FILES.some((pattern) => pathWithinContext.startsWith(pattern));
};

type FileChangeForActor =
    | { impact: 'ignored' }
    | { impact: 'outside-context' }
    | { impact: 'cosmetic'; semanticallyVerified: boolean }
    | { impact: 'functional' };

/**
 * Classify a single file change for a single actor.
 *
 * A changelog is cosmetic for every actor. Other files must be inside a context path.
 * Ignore known development files at the top of that context and files matched by
 * `.dockerignore`, except for files in the actor's `.actor/` directory. A README is
 * cosmetic inside the actor folder and ignored elsewhere. JSON files in `.actor/`
 * are cosmetic only when their schema changes are semantically cosmetic.
 */
const classifyFileChange = async (
    changedFile: RelativeFile,
    actorConfig: ActorConfig,
    commits: Commit[],
    dockerIgnoreMatcher: DockerIgnoreMatcher,
): Promise<FileChangeForActor> => {
    const lowercaseFilePath = changedFile.path.toLowerCase();

    if (lowercaseFilePath.endsWith('changelog.md')) {
        return { impact: 'cosmetic', semanticallyVerified: false };
    }

    const matchedContext = actorConfig.contextPaths.find((contextPath) => contextPath.contains(changedFile));
    if (!matchedContext) {
        return { impact: 'outside-context' };
    }

    if (isIgnoredTopLevelFile(changedFile, matchedContext)) {
        return { impact: 'ignored' };
    }

    const isUnderActorDotDir = actorConfig.actorJson.file.parent.contains(changedFile);

    if (!isUnderActorDotDir && dockerIgnoreMatcher(changedFile.path)) {
        return { impact: 'ignored' };
    }

    const isInActorFolder = changedFile.isWithin(actorConfig.folder);

    if (lowercaseFilePath.endsWith('readme.md')) {
        return isInActorFolder ? { impact: 'cosmetic', semanticallyVerified: false } : { impact: 'ignored' };
    }

    if (lowercaseFilePath.endsWith('.json') && isUnderActorDotDir) {
        const isCosmetic = await isCosmeticOnlyJsonSchemaChange(commits, changedFile.path);
        if (isCosmetic) return { impact: 'cosmetic', semanticallyVerified: true };
    }

    return { impact: 'functional' };
};

/**
 * Exclude files inside another actor's non-root folder, including for an actor at the repo root.
 */
const isExcludedBySibling = (filePath: RelativeFile, actor: ActorConfig, allActors: ActorConfig[]): boolean => {
    const isSibling = (other: ActorConfig) => !other.folder.isEqualTo(actor.folder);
    const isNonRoot = (other: ActorConfig) => !other.folder.isRoot();
    const nonRootSiblings = allActors.filter(isSibling).filter(isNonRoot);
    return nonRootSiblings.some((other) => filePath.isWithin(other.folder));
};

type ActorChangeEntry = {
    actorConfig: ActorConfig;
    files: string[];
};

type ChangeGroup = { actors: string[]; files: string[] };

/**
 * Maps each changed file to the set of actor names it triggered a change for.
 */
const buildFileToActorsMap = (actorsChangedMap: Map<string, ActorChangeEntry>): Map<string, Set<string>> => {
    const fileToActors = new Map<string, Set<string>>();
    for (const { actorConfig, files } of actorsChangedMap.values()) {
        for (const file of files) {
            const actors = fileToActors.get(file) ?? new Set<string>();
            actors.add(actorConfig.actorFullName);
            fileToActors.set(file, actors);
        }
    }
    return fileToActors;
};

/**
 * Groups files by their identical actor-set (files triggering a change for the exact same
 * actors are grouped together), then orders the groups by descending actor-set size
 * (most-shared groups first), breaking ties alphabetically by actor names.
 */
const groupFilesByActorSet = (fileToActors: Map<string, Set<string>>): ChangeGroup[] => {
    const groupsByKey = new Map<string, ChangeGroup>();
    for (const [file, actorsSet] of fileToActors) {
        const actors = Array.from(actorsSet).sort();
        const key = actors.join(',');
        const group = groupsByKey.get(key) ?? { actors, files: [] };
        group.files.push(file);
        groupsByKey.set(key, group);
    }

    return Array.from(groupsByKey.values()).sort((groupA, groupB) => {
        if (groupB.actors.length !== groupA.actors.length) {
            return groupB.actors.length - groupA.actors.length;
        }
        return groupA.actors.join(',').localeCompare(groupB.actors.join(','));
    });
};

const logChangeGroups = (groups: ChangeGroup[]): void => {
    for (const { actors, files } of groups) {
        if (actors.length > 1) {
            logger.info(`[DIFF]: Shared changes for actors ${actors.join(', ')}: ${files.join(', ')}`);
        } else {
            logger.info(`[DIFF]: Changes specific to actor ${actors[0]}: ${files.join(', ')}`);
        }
    }
};

export const getChangedActors = async ({
    filepathsChanged,
    actorConfigs,
    isLatest = false,
    commits,
}: ShouldBuildAndTestOptions): Promise<ActorConfig[]> => {
    const actorsChangedMap = new Map<string, ActorChangeEntry>();

    for (const actorConfig of actorConfigs) {
        const dockerIgnoreMatcher = loadDockerIgnore(actorConfig.dockerContextDir);

        for (const originalFilePath of filepathsChanged) {
            const filePath = new RelativeFile(originalFilePath);

            if (isExcludedBySibling(filePath, actorConfig, actorConfigs)) {
                continue;
            }

            const change = await classifyFileChange(filePath, actorConfig, commits, dockerIgnoreMatcher);

            if (change.impact === 'ignored' || change.impact === 'outside-context') continue;
            if (change.impact === 'cosmetic' && !isLatest) continue;

            const entry = actorsChangedMap.get(actorConfig.folder.path) ?? { actorConfig, files: [] };
            entry.files.push(originalFilePath);
            actorsChangedMap.set(actorConfig.folder.path, entry);
        }
    }

    const actorsChanged = Array.from(actorsChangedMap.values()).map((entry) => entry.actorConfig);

    // Log changes grouped by actor set, so changes shared across actors are logged once
    // instead of being repeated per actor.
    const fileToActors = buildFileToActorsMap(actorsChangedMap);
    const groups = groupFilesByActorSet(fileToActors);
    logChangeGroups(groups);

    if (actorsChanged.length > 0) {
        const actors = actorsChanged.map((config) => config.actorFullName);
        logger.info(`[DIFF]: Actors to be built and tested: ${actors.join(', ')}`);
    } else {
        logger.info(`[DIFF]: No relevant files changed, skipping builds and tests`);
    }

    return actorsChanged;
};
