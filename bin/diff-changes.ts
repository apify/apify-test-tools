import { isCosmeticOnlyJsonSchemaChange } from './diff-json-schema.js';
import { type DockerIgnoreMatcher, loadDockerIgnore } from './dockerignore.js';
import { logger } from './logger.js';
import { createTestFilesMatcher } from './test-files-glob.js';
import type { ActorConfig, GitRange } from './types.js';
import { type RelativeDir, RelativeFile } from './utils/path/repo-relative.js';

interface ShouldBuildAndTestOptions {
    filepathsChanged: string[];
    actorConfigs: ActorConfig[];
    /** The range the files changed in, to compare `.actor` JSON files across. */
    range: GitRange;
    /**
     * Glob of the platform test files, from the repo root (`platformTestsGlob` in the config). A change to a matching
     * file is a test change, even when .dockerignore lists it.
     */
    platformTestsGlob?: string;
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
    // A context entry that names the file itself is checked by the file's name, as if its folder were the context
    const scope = contextPath.path === filePath.path ? filePath.parent : contextPath;
    const pathWithinContext = scope.relativePathTo(filePath.path).toLowerCase();
    return IGNORED_TOP_LEVEL_FILES.some((pattern) => pathWithinContext.startsWith(pattern));
};

type FileChangeForActor =
    | { impact: 'ignored' }
    | { impact: 'outside-context' }
    | { impact: 'cosmetic'; semanticallyVerified: boolean }
    | { impact: 'test' }
    | { impact: 'functional' };

/**
 * Classify a single file change for a single actor.
 *
 * Steps (in order):
 * 1. Resolved documentation → cosmetic; actor.json and schemas → semantic check; Dockerfile → functional.
 *    These dependencies count regardless of sibling folders, context, or ignores.
 * 2. Sibling exclusion → outside-context
 * 3. Context matching (actorConfig.contextPaths) → outside-context if no match
 * 4. Hardcoded ignore list, checked against the path hoisted relative to the matched context entry → ignored
 * 5. .dockerignore filtering (patterns relative to dockerContextDir), skipped for the actor's own `.actor/`
 *    dir and for test files → ignored if matched
 * 6. Everything else → functional
 */
const classifyFileChange = async (
    changedFile: RelativeFile,
    actorConfig: ActorConfig,
    allActors: ActorConfig[],
    range: GitRange,
    dockerIgnoreMatcher: DockerIgnoreMatcher,
    isTestFile: (filePath: string) => boolean,
): Promise<FileChangeForActor> => {
    const {
        file,
        readme,
        changelog,
        dockerfile,
        inputSchema,
        outputSchema,
        webServerSchema,
        datasetSchemas = [],
        keyValueStoreSchema,
    } = actorConfig.actorJson;
    const matches = (candidate: RelativeFile | undefined) => candidate?.isEqualTo(changedFile) ?? false;

    if (matches(dockerfile)) return { impact: 'functional' };

    if ([file, inputSchema, outputSchema, webServerSchema, ...datasetSchemas, keyValueStoreSchema].some(matches)) {
        const isCosmetic = await isCosmeticOnlyJsonSchemaChange(range, changedFile.path);
        return isCosmetic ? { impact: 'cosmetic', semanticallyVerified: true } : { impact: 'functional' };
    }

    if ([readme, changelog].some(matches)) {
        return { impact: 'cosmetic', semanticallyVerified: false };
    }

    if (isExcludedBySibling(changedFile, actorConfig, allActors)) {
        return { impact: 'outside-context' };
    }

    // An entry can also name a single file, e.g. a root package-lock.json shared by all Actors
    const matchedContext = actorConfig.contextPaths.find(
        (contextPath) => contextPath.contains(changedFile) || contextPath.path === changedFile.path,
    );
    if (!matchedContext) {
        return { impact: 'outside-context' };
    }

    if (isIgnoredTopLevelFile(changedFile, matchedContext)) {
        return { impact: 'ignored' };
    }

    // Test files are often in .dockerignore, but a change to them must still run the tests
    if (isTestFile(changedFile.path)) {
        return { impact: 'test' };
    }

    const isUnderActorDotDir = actorConfig.actorJson.file.parent.contains(changedFile);

    // .actor/ can legitimately be listed in .dockerignore (the Apify platform evaluates it before
    // the Docker build, so excluding it from the build context is a valid caching optimization) —
    // that shouldn't cause changes to .actor/ itself to be ignored here.
    if (!isUnderActorDotDir && dockerIgnoreMatcher(changedFile.path)) {
        return { impact: 'ignored' };
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
    hasFunctionalChange: boolean;
    hasCosmeticChange: boolean;
    hasTestChange: boolean;
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

export interface ChangedActors {
    /** Actors with at least one functional change. They need a new build and tests. */
    functional: ActorConfig[];
    /** Actors with cosmetic changes and no functional one. They only need a new build when released. */
    cosmetic: ActorConfig[];
    /**
     * Actors with at least one platform test change, whatever else changed. Their tests need to run, but test changes
     * alone need no release. An Actor can be in this list and in one of the others.
     */
    test: ActorConfig[];
}

/** Finds the Actors the changed files belong to, split by the most impactful change each Actor has. */
export const getChangedActors = async ({
    filepathsChanged,
    actorConfigs,
    range,
    platformTestsGlob,
}: ShouldBuildAndTestOptions): Promise<ChangedActors> => {
    const actorsChangedMap = new Map<string, ActorChangeEntry>();
    const testFilesInContext = new Set<string>();
    const isTestFile = createTestFilesMatcher(platformTestsGlob);

    for (const actorConfig of actorConfigs) {
        const dockerIgnoreMatcher = loadDockerIgnore(actorConfig.dockerContextDir);

        for (const originalFilePath of filepathsChanged) {
            const filePath = new RelativeFile(originalFilePath);

            const change = await classifyFileChange(
                filePath,
                actorConfig,
                actorConfigs,
                range,
                dockerIgnoreMatcher,
                isTestFile,
            );
            if (change.impact !== 'outside-context' && isTestFile(originalFilePath)) {
                testFilesInContext.add(originalFilePath);
            }

            if (change.impact === 'ignored' || change.impact === 'outside-context') continue;

            const entry = actorsChangedMap.get(actorConfig.folder.path) ?? {
                actorConfig,
                files: [],
                hasFunctionalChange: false,
                hasCosmeticChange: false,
                hasTestChange: false,
            };
            entry.files.push(originalFilePath);
            entry.hasFunctionalChange ||= change.impact === 'functional';
            entry.hasCosmeticChange ||= change.impact === 'cosmetic';
            entry.hasTestChange ||= change.impact === 'test';
            actorsChangedMap.set(actorConfig.folder.path, entry);
        }
    }

    // Log changes grouped by actor set, so changes shared across actors are logged once
    // instead of being repeated per actor.
    logChangeGroups(groupFilesByActorSet(buildFileToActorsMap(actorsChangedMap)));

    for (const testFile of filepathsChanged.filter(
        (filePath) => isTestFile(filePath) && !testFilesInContext.has(filePath),
    )) {
        logger.warn(
            `[DIFF]: Test file ${testFile} is outside every Actor's context, so changing only it builds and tests nothing. ` +
                `Add its folder to "overrideActorContext" of the Actors it tests.`,
        );
    }

    const entries = Array.from(actorsChangedMap.values());
    const functional = entries.filter((entry) => entry.hasFunctionalChange).map((entry) => entry.actorConfig);
    const cosmetic = entries
        .filter((entry) => !entry.hasFunctionalChange && entry.hasCosmeticChange)
        .map((entry) => entry.actorConfig);
    const test = entries.filter((entry) => entry.hasTestChange).map((entry) => entry.actorConfig);

    const names = (configs: ActorConfig[]) => configs.map((config) => config.actorFullName).join(', ') || 'none';
    logger.info(`[DIFF]: Actors with functional changes: ${names(functional)}`);
    logger.info(`[DIFF]: Actors with only cosmetic changes: ${names(cosmetic)}`);
    logger.info(`[DIFF]: Actors with platform test changes: ${names(test)}`);

    return { functional, cosmetic, test };
};
