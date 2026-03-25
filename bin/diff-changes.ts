import { isCosmeticOnlyJsonSchemaChange } from './diff-json-schema.js';
import type { ActorConfig, Commit } from './types.js';

interface ShouldBuildAndTestOptions {
    filepathsChanged: string[];
    actorConfigs: ActorConfig[];
    isLatest?: boolean;
    commits: Commit[];
}

export const maybeParseActorFolder = (
    lowercaseFilePath: string,
): { isActorFolder: true; actorName: string } | { isActorFolder: false } => {
    const match = lowercaseFilePath.match(/^(?:standalone-)?actors\/([^/]+)\/.+/);
    if (match) {
        // Some usernames weirdly use underscores, e.g. google_maps_email_extractor_standby-contact-details-scraper so we only need replace the last one
        return { isActorFolder: true, actorName: match[1].replace(/_(?=[^_]*$)/, '/') };
    }
    return { isActorFolder: false };
};

/**
 * Also works for folders
 */
const isIgnoredTopLevelFile = (lowercaseFilePath: string) => {
    // On top level, we should only have dev-only readme and .actor/ is just for apify push CLI (real Actor configs are in /actors)
    const IGNORED_TOP_LEVEL_FILES = [
        '.vscode/',
        '.gitignore',
        'readme.md',
        '.husky/',
        '.eslintrc',
        'eslint.config.mjs',
        '.prettierrc',
        '.editorconfig',
        '.actor/',
    ];
    // Strip out deprecated /code and /shared folders, treat them as top-level code
    const sanitizedLowercaseFilePath = lowercaseFilePath.replace(/^code\//, '').replace(/^shared\//, '');

    return IGNORED_TOP_LEVEL_FILES.some((ignoredFile) => sanitizedLowercaseFilePath.startsWith(ignoredFile));
};

type FileChange =
    | { impact: 'ignored' }
    // Only things that influence how the Actor looks - e.g. README and CHANGELOG files, schema titles, descriptions, reordering, etc. We only need to rebuild on release
    | { impact: 'cosmetic'; includes: 'all-actors' | ActorConfig }
    // Influences how the Actor works - we need to run tests
    | {
          impact: 'functional';
          includes: 'all-actors' | ActorConfig;
      };

const classifyFileChange = (lowercaseFilePath: string, actorConfigs: ActorConfig[], commits: Commit[]): FileChange => {
    if (isIgnoredTopLevelFile(lowercaseFilePath)) {
        return { impact: 'ignored' };
    }

    if (lowercaseFilePath.endsWith('changelog.md')) {
        return { impact: 'cosmetic', includes: 'all-actors' };
    }

    const actorFolderInfo = maybeParseActorFolder(lowercaseFilePath);
    if (actorFolderInfo.isActorFolder) {
        const actorConfigChanged = actorConfigs.find(
            ({ actorName }) => actorName.toLowerCase() === actorFolderInfo.actorName,
        );
        // This is some super weird case that happened once in the past but I don't remember the context anymore
        if (actorConfigChanged === undefined) {
            console.error(
                'SHOULD NEVER HAPPEN: changes was found in an actor folder which no longer exists in the current commit, skipping this file',
                {
                    actorName: actorFolderInfo.actorName,
                    lowercaseFilePath,
                },
            );
            return { impact: 'ignored' };
        }
        if (lowercaseFilePath.endsWith('readme.md')) {
            return { impact: 'cosmetic', includes: actorConfigChanged };
        }
        if (lowercaseFilePath.endsWith('.json') && isCosmeticOnlyJsonSchemaChange(commits, lowercaseFilePath)) {
            return { impact: 'cosmetic', includes: actorConfigChanged };
        }

        return { impact: 'functional', includes: actorConfigChanged };
    }

    // For any other files, we assume they can interact with the code
    return { impact: 'functional', includes: 'all-actors' };
};

export const getChangedActors = ({
    filepathsChanged,
    actorConfigs,
    isLatest = false,
    commits,
}: ShouldBuildAndTestOptions): ActorConfig[] => {
    // folder -> ActorConfig
    const actorsChangedMap = new Map<string, ActorConfig>();

    const actorConfigsWithoutStandalone = actorConfigs.filter(({ isStandalone }) => !isStandalone);

    const lowercaseFiles = filepathsChanged.map((file) => file.toLowerCase());

    for (const lowercaseFilePath of lowercaseFiles) {
        const fileChange = classifyFileChange(lowercaseFilePath, actorConfigs, commits);
        if (fileChange.impact === 'ignored') {
            continue;
        }

        if (fileChange.impact === 'cosmetic' && !isLatest) {
            continue;
        }

        if (fileChange.includes !== 'all-actors') {
            actorsChangedMap.set(fileChange.includes.folder, fileChange.includes);
        } else if (fileChange.includes === 'all-actors') {
            // Standalone Actors are handled always via specific actors change, not all-actors
            for (const actorConfig of actorConfigsWithoutStandalone) {
                actorsChangedMap.set(actorConfig.folder, actorConfig);
            }
        }
    }

    const actorsChanged = Array.from(actorsChangedMap.values());

    // All below here is just for logging
    const ignoredFilesChanged = lowercaseFiles.filter(
        (file) => classifyFileChange(file, actorConfigs, commits).impact === 'ignored',
    );
    console.error(`[DIFF]: Ignored files (don't trigger test or build): ${ignoredFilesChanged.join(', ')}`);

    const cosmeticFilesChanged = lowercaseFiles.filter(
        (file) => classifyFileChange(file, actorConfigs, commits).impact === 'cosmetic',
    );
    console.error(`[DIFF]: Cosmetic files (should only trigger release build): ${cosmeticFilesChanged.join(', ')}`);

    const functionalFilesChanged = lowercaseFiles.filter(
        (file) => classifyFileChange(file, actorConfigs, commits).impact === 'functional',
    );
    console.error(`[DIFF]: Functional files (trigger test & release build): ${functionalFilesChanged.join(', ')}`);

    if (actorsChanged.length > 0) {
        const miniactors = actorsChanged.filter((config) => !config.isStandalone).map((config) => config.actorName);
        const standaloneActors = actorsChanged
            .filter((config) => config.isStandalone)
            .map((config) => config.actorName);
        console.error(`[DIFF]: MiniActors to be built and tested: ${miniactors.join(', ')}`);
        console.error(`[DIFF]: Standalone Actors to be built and tested: ${standaloneActors.join(', ')}`);
    } else {
        console.error(`[DIFF]: No relevant files changed, skipping builds and tests`);
    }

    return actorsChanged;
};
