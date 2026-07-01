import { isCosmeticOnlyJsonSchemaChange } from './diff-json-schema.js';
import { type DockerIgnoreMatcher, loadDockerIgnore } from './dockerignore.js';
import type { ActorConfig, Commit } from './types.js';

interface ShouldBuildAndTestOptions {
    filepathsChanged: string[];
    actorConfigs: ActorConfig[];
    isLatest?: boolean;
    commits: Commit[];
}

const isIgnoredTopLevelFile = (lowercaseFilePath: string) => {
    const IGNORED_TOP_LEVEL_FILES = [
        '.vscode/',
        '.gitignore',
        'readme.md',
        '.husky/',
        '.eslintrc',
        'eslint.config.mjs',
        '.prettierrc',
        '.editorconfig',
    ];
    // Strip deprecated code/ and shared/ prefixes — repos like apify-store/amazon use these
    const sanitized = lowercaseFilePath.replace(/^code\//, '').replace(/^shared\//, '');
    return IGNORED_TOP_LEVEL_FILES.some((pattern) => sanitized.startsWith(pattern));
};

type FileChangeForActor =
    | { impact: 'ignored' }
    | { impact: 'outside-context' }
    | { impact: 'cosmetic'; semanticallyVerified: boolean }
    | { impact: 'functional' };

const isFileInContext = (lowercaseFilePath: string, actor: ActorConfig): boolean => {
    if (actor.overrideActorContext) {
        return actor.overrideActorContext.some((contextPath) => {
            const lowerContextPath = contextPath.toLowerCase();
            return lowerContextPath === '' || lowercaseFilePath.startsWith(`${lowerContextPath}/`);
        });
    }
    const lowerDockerContext = actor.dockerContextDir.toLowerCase();
    return lowerDockerContext === '' || lowercaseFilePath.startsWith(`${lowerDockerContext}/`);
};

/**
 * Classify a single file change for a single actor.
 *
 * Steps (in order):
 * 1. Hardcoded ignore list (repo-level dev files) → ignored
 * 2. Context matching (dockerContextDir or overrideActorContext) → outside-context if no match
 * 3. .dockerignore filtering (patterns relative to dockerContextDir) → ignored if matched
 * 4. README/CHANGELOG by filename → cosmetic (not semantically verified)
 * 5. .json inside the actor's own folder with only cosmetic schema diffs → cosmetic (semantically verified)
 * 6. Everything else → functional
 */
const classifyFileChange = (
    originalFilePath: string,
    actorConfig: ActorConfig,
    commits: Commit[],
    cosmeticCache: Map<string, boolean>,
    dockerIgnoreMatcher: DockerIgnoreMatcher,
): FileChangeForActor => {
    const lowercaseFilePath = originalFilePath.toLowerCase();

    if (isIgnoredTopLevelFile(lowercaseFilePath)) {
        return { impact: 'ignored' };
    }

    if (!isFileInContext(lowercaseFilePath, actorConfig)) {
        return { impact: 'outside-context' };
    }

    if (dockerIgnoreMatcher(originalFilePath)) {
        return { impact: 'ignored' };
    }

    if (lowercaseFilePath.endsWith('readme.md') || lowercaseFilePath.endsWith('changelog.md')) {
        return { impact: 'cosmetic', semanticallyVerified: false };
    }

    const lowerFolder = actorConfig.folder.toLowerCase();
    const isInActorFolder = lowerFolder === '' || lowercaseFilePath.startsWith(`${lowerFolder}/`);
    if (lowercaseFilePath.endsWith('.json') && isInActorFolder) {
        let isCosmetic = cosmeticCache.get(originalFilePath);
        if (isCosmetic === undefined) {
            isCosmetic = isCosmeticOnlyJsonSchemaChange(commits, originalFilePath);
            cosmeticCache.set(originalFilePath, isCosmetic);
        }
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
            lowercaseFilePath.startsWith(`${other.folder.toLowerCase()}/`),
    );
};

type LoggableImpact = 'ignored' | 'cosmetic' | 'functional';

const IMPACT_PRIORITY: Record<string, number> = { functional: 3, cosmetic: 2, ignored: 1 };

/**
 * A file can be classified differently by different actors (e.g. functional for a broad-context
 * actor, outside-context for a narrow one). For logging we keep the most significant classification
 * across all actors: functional > cosmetic > ignored. Files that are outside-context for every
 * actor are treated as ignored.
 */
const updateFileImpact = (
    fileImpacts: Map<string, LoggableImpact>,
    filePath: string,
    impact: FileChangeForActor['impact'],
): void => {
    if (impact === 'outside-context') return;

    const loggable = impact as LoggableImpact;
    const current = fileImpacts.get(filePath);
    if (!current || IMPACT_PRIORITY[loggable] > IMPACT_PRIORITY[current]) {
        fileImpacts.set(filePath, loggable);
    }
};

export const getChangedActors = ({
    filepathsChanged,
    actorConfigs,
    isLatest = false,
    commits,
}: ShouldBuildAndTestOptions): ActorConfig[] => {
    const actorsChangedMap = new Map<string, ActorConfig>();
    const cosmeticCache = new Map<string, boolean>();
    const fileImpacts = new Map<string, LoggableImpact>();

    for (const actorConfig of actorConfigs) {
        const dockerIgnoreMatcher = loadDockerIgnore(actorConfig.dockerContextDir);

        for (const originalFilePath of filepathsChanged) {
            const lowercaseFilePath = originalFilePath.toLowerCase();

            if (isExcludedBySibling(lowercaseFilePath, actorConfig, actorConfigs)) {
                continue;
            }

            const change = classifyFileChange(
                originalFilePath,
                actorConfig,
                commits,
                cosmeticCache,
                dockerIgnoreMatcher,
            );
            updateFileImpact(fileImpacts, originalFilePath, change.impact);

            if (change.impact === 'ignored' || change.impact === 'outside-context') continue;
            if (change.impact === 'cosmetic' && !isLatest) continue;

            actorsChangedMap.set(actorConfig.folder, actorConfig);
        }
    }

    const actorsChanged = Array.from(actorsChangedMap.values());

    // Logging
    const formatFiles = (files: string[]) => (files.length > 0 ? files.join(', ') : '<no files>');

    const ignoredFiles = filepathsChanged.filter((file) => {
        const impact = fileImpacts.get(file);
        return impact === 'ignored' || !impact;
    });
    const cosmeticFiles = filepathsChanged.filter((file) => fileImpacts.get(file) === 'cosmetic');
    const functionalFiles = filepathsChanged.filter((file) => fileImpacts.get(file) === 'functional');

    console.error(`[DIFF]: Ignored files (don't trigger test or build): ${formatFiles(ignoredFiles)}`);
    console.error(`[DIFF]: Cosmetic files (only trigger release build): ${formatFiles(cosmeticFiles)}`);
    console.error(`[DIFF]: Functional files (trigger test & release build): ${formatFiles(functionalFiles)}`);

    if (actorsChanged.length > 0) {
        const actorNames = actorsChanged.map((config) => config.actorName);
        console.error(`[DIFF]: Actors to be built and tested: ${actorNames.join(', ')}`);
    } else {
        console.error(`[DIFF]: No relevant files changed, skipping builds and tests`);
    }

    return actorsChanged;
};
