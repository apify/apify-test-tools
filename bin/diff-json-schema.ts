import { logger } from './logger.js';
import type { Commit } from './types.js';
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
 * Returns true if the two JSON strings differ only in cosmetic fields
 * (title, description, example, enumTitles, sectionCaption, sectionDescription).
 */
export const isCosmeticOnlyJsonSchemaChange = async (commits: Commit[], changedFilepath: string): Promise<boolean> => {
    // TODO: validate this is the right commit range
    const oldRef = `${commits[0].sha}~`;
    const newRef = commits[commits.length - 1].sha;

    const [oldJson, newJson] = await Promise.all([
        runGitCommand(['show', `${oldRef}:${changedFilepath}`])
            .then(JSON.parse)
            .catch(() => undefined),
        runGitCommand(['show', `${newRef}:${changedFilepath}`])
            .then(JSON.parse)
            .catch(() => undefined),
    ]);
    if (!oldJson || !newJson) {
        logger.info(
            `Failed to get JSON content for ${changedFilepath} at refs ${oldRef} and ${newRef}, maybe it is new file or deleted? Treating it as a non-cosmetic change.`,
        );
        return false;
    }
    return isCosmeticObjectChange(oldJson, newJson);
};
