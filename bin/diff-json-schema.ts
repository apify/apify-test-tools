import type { ResolvedGitFileDiff } from './git-file-diff.js';
import { logger } from './logger.js';
import { runGitCommand } from './utils.js';

const COSMETIC_JSON_FIELD_NAMES = new Set([
    'title',
    'description',
    'example',
    'enumTitles',
    'sectionCaption',
    'sectionDescription',
]);

const isPlainObject = (val: unknown): val is Record<string, unknown> =>
    typeof val === 'object' && val !== null && !Array.isArray(val);

const isCosmeticObjectChange = (oldVal: unknown, newVal: unknown, currentKey?: string): boolean => {
    // If the key itself is cosmetic, any change under it is fine
    if (currentKey && COSMETIC_JSON_FIELD_NAMES.has(currentKey)) return true;
    if (JSON.stringify(oldVal) === JSON.stringify(newVal)) return true;
    if (isPlainObject(oldVal) && isPlainObject(newVal)) {
        const allKeys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);
        return [...allKeys].every((key) => isCosmeticObjectChange(oldVal[key], newVal[key], key));
    }
    return false;
};

/**
 * Returns true when the selected JSON file differs only in cosmetic fields
 * across every baseline represented by the resolved diff.
 */
export const isCosmeticOnlyJsonSchemaChange = async (
    diff: ResolvedGitFileDiff,
    changedFilepath: string,
): Promise<boolean> => {
    const [mergeBaseJson, newJson] = await Promise.all([
        runGitCommand(['show', `${diff.mergeBaseSha}:${changedFilepath}`])
            .then(JSON.parse)
            .catch(() => undefined),
        runGitCommand(['show', `${diff.currentRef}:${changedFilepath}`])
            .then(JSON.parse)
            .catch(() => undefined),
    ]);
    if (!mergeBaseJson || !newJson) {
        logger.info(
            `Failed to get JSON content for ${changedFilepath} at refs ${diff.mergeBaseSha} and ${diff.currentRef}, maybe it is new file or deleted? Treating it as a non-cosmetic change.`,
        );
        return false;
    }
    const isBranchACosmeticChange = isCosmeticObjectChange(mergeBaseJson, newJson);

    if (diff.resolutionType === 'simple') {
        return isBranchACosmeticChange;
    }
    const previousRevisionJson = await runGitCommand(['show', `${diff.baseCommit}:${changedFilepath}`])
        .then(JSON.parse)
        .catch(() => undefined);
    if (!previousRevisionJson) {
        logger.info(
            `Failed to get JSON content for ${changedFilepath} at refs ${diff.baseCommit}, maybe it is new file or deleted? Treating it as a non-cosmetic change.`,
        );
        return false;
    }
    const isChangeFromPreviousCosmetic = isCosmeticObjectChange(previousRevisionJson, newJson);
    // Same as diffing, we need the intersection of the two cosmetics to be cosmetic overall
    return isBranchACosmeticChange && isChangeFromPreviousCosmetic;
};
