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

const getJsonFileVersions = async (
    filePath: string,
    diff: ResolvedGitFileDiff,
): Promise<{
    mergeBaseJson?: unknown;
    currentJson?: unknown;
    baseCommitJson?: unknown;
}> => {
    const readJson = async (ref: string): Promise<unknown | undefined> => {
        try {
            return JSON.parse(await runGitCommand(['show', `${ref}:${filePath}`]));
        } catch {
            return undefined;
        }
    };

    const refs = [
        diff.mergeBaseSha,
        diff.currentRef,
        ...(diff.resolutionType === 'intersection' ? [diff.baseCommit] : []),
    ];
    // destructuring `baseCommitJson` out of range is intentional, since it will be undefined which is what we want
    const [mergeBaseJson, currentJson, baseCommitJson] = await Promise.all(refs.map(readJson));
    return { mergeBaseJson, currentJson, baseCommitJson };
};

/**
 * Returns true when the selected JSON file differs only in cosmetic fields
 * across every baseline represented by the resolved diff.
 */
export const isCosmeticOnlyJsonSchemaChange = async (
    diff: ResolvedGitFileDiff,
    changedFilepath: string,
): Promise<boolean> => {
    let { mergeBaseJson, currentJson, baseCommitJson } = await getJsonFileVersions(changedFilepath, diff);
    // 2 cases here and none of them are expected:
    // - none are defined, but then how do we got a diff?? probably malformed everywhere
    // - only baseCommitJson is defined which might be all malformed or deleted outside of branch (which shouldn't be able to get past our previous checks)
    if (!mergeBaseJson && !currentJson) {
        logger.info(
            `Could not read JSON content for ${changedFilepath} at refs ${diff.mergeBaseSha} and ${diff.currentRef}. Could the file be missing or malformed at both refs? Treating the change as non-cosmetic.`,
        );
        return false;
    }
    // Compare an unavailable version with an empty object. The change is cosmetic
    // only if every field in the available version is cosmetic, as can happen when
    // adding or deleting a file containing only cosmetic fields.
    mergeBaseJson ??= {};
    currentJson ??= {};
    const isBranchACosmeticChange = isCosmeticObjectChange(mergeBaseJson, currentJson);

    if (diff.resolutionType === 'simple') {
        return isBranchACosmeticChange;
    }
    if (!baseCommitJson) {
        logger.info(
            `Could not read JSON content for ${changedFilepath} at ref ${diff.baseCommit}. Could the file be missing or malformed there? Comparing that version as an empty object.`,
        );
        // this might doom the comparison to false, but it could still go through in some cases
        baseCommitJson ??= {};
    }
    const isChangeFromPreviousCosmetic = isCosmeticObjectChange(baseCommitJson, currentJson);
    // Same as diffing, we need the intersection of the two cosmetics to be cosmetic overall
    return isBranchACosmeticChange && isChangeFromPreviousCosmetic;
};
