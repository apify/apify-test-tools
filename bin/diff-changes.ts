import picomatch from 'picomatch';

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
    // Glob relative to the repo root. Matching files count as changes even when .dockerignore lists them.
    testFilesGlob?: string;
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
 * Steps (in order):
 * 1. CHANGELOG.md, by filename, anywhere → cosmetic. There is a single repo-wide shared changelog,
 *    not one per actor, so it applies to every actor regardless of context/folder.
 * 2. Context matching (actorConfig.contextPaths) → outside-context if no match
 * 3. Hardcoded ignore list, checked against the path hoisted relative to the matched context entry → ignored
 * 4. .dockerignore filtering (patterns relative to dockerContextDir), skipped for the actor's own `.actor/`
 *    dir and for test files → ignored if matched
 * 5. README.md by filename → cosmetic if inside the actor's own folder, otherwise ignored
 * 6. .json inside the actor's own `.actor/` dir with only cosmetic schema diffs → cosmetic (semantically verified)
 * 7. Everything else → functional
 */
const classifyFileChange = async (
    changedFile: RelativeFile,
    actorConfig: ActorConfig,
    commits: Commit[],
    dockerIgnoreMatcher: DockerIgnoreMatcher,
    isTestFile: (filePath: string) => boolean,
): Promise<FileChangeForActor> => {
    const lowercaseFilePath = changedFile.path.toLowerCase();

    // TODO: hardcodes that there's a single repo-wide changelog belonging to every actor. Should instead
    // be derived from parsing actor.json (readme, changelog, schema paths), see
    // https://github.com/apify/apify-test-tools/issues/106
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

    // .actor/ can legitimately be listed in .dockerignore (the Apify platform evaluates it before
    // the Docker build, so excluding it from the build context is a valid caching optimization) —
    // that shouldn't cause changes to .actor/ itself to be ignored here.
    // Test files are often in .dockerignore too, but a change to them must still build and test.
    if (!isUnderActorDotDir && !isTestFile(changedFile.path) && dockerIgnoreMatcher(changedFile.path)) {
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
    testFilesGlob,
}: ShouldBuildAndTestOptions): Promise<ActorConfig[]> => {
    const actorsChangedMap = new Map<string, ActorChangeEntry>();
    const testFilesInContext = new Set<string>();
    const isTestFile = testFilesGlob ? picomatch(testFilesGlob, { nocase: true, dot: true }) : () => false;

    for (const actorConfig of actorConfigs) {
        const dockerIgnoreMatcher = loadDockerIgnore(actorConfig.dockerContextDir);

        for (const originalFilePath of filepathsChanged) {
            const filePath = new RelativeFile(originalFilePath);

            if (isExcludedBySibling(filePath, actorConfig, actorConfigs)) {
                continue;
            }

            const change = await classifyFileChange(filePath, actorConfig, commits, dockerIgnoreMatcher, isTestFile);
            if (change.impact !== 'outside-context' && isTestFile(originalFilePath)) {
                testFilesInContext.add(originalFilePath);
            }

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

    for (const testFile of filepathsChanged.filter(
        (filePath) => isTestFile(filePath) && !testFilesInContext.has(filePath),
    )) {
        logger.warn(
            `[DIFF]: Test file ${testFile} is outside every Actor's context, so changing only it builds and tests nothing. ` +
                `Add its folder to "overrideActorContext" of the Actors it tests.`,
        );
    }

    if (actorsChanged.length > 0) {
        const actors = actorsChanged.map((config) => config.actorFullName);
        logger.info(`[DIFF]: Actors to be built and tested: ${actors.join(', ')}`);
    } else {
        logger.info(`[DIFF]: No relevant files changed, skipping builds and tests`);
    }

    return actorsChanged;
};
