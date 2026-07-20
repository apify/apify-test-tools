import { isCosmeticOnlyJsonSchemaChange } from './diff-json-schema.js';
import { type DockerIgnoreMatcher, loadDockerIgnore } from './dockerignore.js';
import { findContainingScope, hoistPath, isPathWithinScope } from './path-utils.js';
import type { ActorConfig, Commit } from './types.js';

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

// Expects an already-hoisted path (relative to the matched context entry, see findContainingScope).
const isIgnoredTopLevelFile = (hoistedLowercaseFilePath: string): boolean =>
    IGNORED_TOP_LEVEL_FILES.some((pattern) => hoistedLowercaseFilePath.startsWith(pattern));

type FileChangeForActor =
    | { impact: 'ignored' }
    | { impact: 'outside-context' }
    | { impact: 'cosmetic'; semanticallyVerified: boolean }
    | { impact: 'functional' };

/**
 * Classify a single file change for a single actor.
 *
 * Steps (in order):
 * 1. Context matching (actorConfig.contextPaths) → outside-context if no match
 * 2. Hardcoded ignore list, checked against the path hoisted relative to the matched context entry → ignored
 * 3. .dockerignore filtering (patterns relative to dockerContextDir), skipped for the actor's own `.actor/`
 *    dir → ignored if matched
 * 4. README/CHANGELOG by filename → cosmetic if inside the actor's own folder, otherwise ignored
 * 5. .json inside the actor's own `.actor/` dir with only cosmetic schema diffs → cosmetic (semantically verified)
 * 6. Everything else → functional
 */
const classifyFileChange = (
    originalFilePath: string,
    actorConfig: ActorConfig,
    commits: Commit[],
    dockerIgnoreMatcher: DockerIgnoreMatcher,
): FileChangeForActor => {
    const lowercaseFilePath = originalFilePath.toLowerCase();
    const lowercaseContextPaths = actorConfig.contextPaths.map((contextPath) => contextPath.toLowerCase());

    const matchedContext = findContainingScope(lowercaseFilePath, lowercaseContextPaths);
    if (matchedContext === undefined) {
        return { impact: 'outside-context' };
    }

    const hoistedFilePath = hoistPath(lowercaseFilePath, matchedContext);
    if (isIgnoredTopLevelFile(hoistedFilePath)) {
        return { impact: 'ignored' };
    }

    const lowercaseFolder = actorConfig.folder.toLowerCase();
    const actorDotDir = lowercaseFolder ? `${lowercaseFolder}/.actor` : '.actor';
    const isUnderActorDotDir = isPathWithinScope(lowercaseFilePath, actorDotDir);

    // .actor/ can legitimately be listed in .dockerignore (the Apify platform evaluates it before
    // the Docker build, so excluding it from the build context is a valid caching optimization) —
    // that shouldn't cause changes to .actor/ itself to be ignored here.
    if (!isUnderActorDotDir && dockerIgnoreMatcher(originalFilePath)) {
        return { impact: 'ignored' };
    }

    const isInActorFolder = isPathWithinScope(lowercaseFilePath, lowercaseFolder);

    if (lowercaseFilePath.endsWith('readme.md') || lowercaseFilePath.endsWith('changelog.md')) {
        return isInActorFolder ? { impact: 'cosmetic', semanticallyVerified: false } : { impact: 'ignored' };
    }

    if (lowercaseFilePath.endsWith('.json') && isUnderActorDotDir) {
        const isCosmetic = isCosmeticOnlyJsonSchemaChange(commits, originalFilePath);
        if (isCosmetic) {
            return { impact: 'cosmetic', semanticallyVerified: true };
        }
    }

    return { impact: 'functional' };
};

/**
 * Check if a file falls inside another actor's folder.
 * Root actors (folder === "") never exclude files from siblings.
 */
const isExcludedBySibling = (lowercaseFilePath: string, actor: ActorConfig, allActors: ActorConfig[]): boolean => {
    return allActors.some(
        (other) =>
            other.folder !== actor.folder &&
            other.folder !== '' &&
            isPathWithinScope(lowercaseFilePath, other.folder.toLowerCase()),
    );
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
            console.error(`[DIFF]: Shared changes for actors ${actors.join(', ')}: ${files.join(', ')}`);
        } else {
            console.error(`[DIFF]: Changes specific to actor ${actors[0]}: ${files.join(', ')}`);
        }
    }
};

export const getChangedActors = ({
    filepathsChanged,
    actorConfigs,
    isLatest = false,
    commits,
}: ShouldBuildAndTestOptions): ActorConfig[] => {
    const actorsChangedMap = new Map<string, ActorChangeEntry>();

    for (const actorConfig of actorConfigs) {
        const dockerIgnoreMatcher = loadDockerIgnore(actorConfig.dockerContextDir);

        for (const originalFilePath of filepathsChanged) {
            const lowercaseFilePath = originalFilePath.toLowerCase();

            if (isExcludedBySibling(lowercaseFilePath, actorConfig, actorConfigs)) {
                continue;
            }

            const change = classifyFileChange(originalFilePath, actorConfig, commits, dockerIgnoreMatcher);

            if (change.impact === 'ignored' || change.impact === 'outside-context') continue;
            if (change.impact === 'cosmetic' && !isLatest) continue;

            const entry = actorsChangedMap.get(actorConfig.folder) ?? { actorConfig, files: [] };
            entry.files.push(originalFilePath);
            actorsChangedMap.set(actorConfig.folder, entry);
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
        console.error(`[DIFF]: Actors to be built and tested: ${actors.join(', ')}`);
    } else {
        console.error(`[DIFF]: No relevant files changed, skipping builds and tests`);
    }

    return actorsChanged;
};
