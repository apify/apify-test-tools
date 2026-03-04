import type { Commit } from './types.js';
import { spawnCommandInGhWorkspace } from './utils.js';

const NONFUNCTIONAL_JSON_FIELD_NAMES = new Set([
    'title', 'description', 'example', 'enumTitles', 'sectionCaption', 'sectionDescription',
]);

const isPlainObject = (val: unknown): val is Record<string, unknown> =>
    typeof val === 'object' && val !== null && !Array.isArray(val);

const isNonfunctionalChange = (oldVal: unknown, newVal: unknown, currentKey?: string): boolean => {
    // If the key itself is non-functional, any change under it is fine
    if (currentKey && NONFUNCTIONAL_JSON_FIELD_NAMES.has(currentKey)) return true;
    if (JSON.stringify(oldVal) === JSON.stringify(newVal)) return true;
    if (isPlainObject(oldVal) && isPlainObject(newVal)) {
        const allKeys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);
        return [...allKeys].every((key) => isNonfunctionalChange(oldVal[key], newVal[key], key));
    }
    return false;
};

/**
 * Returns true if the two JSON strings differ only in non-functional fields
 * (title, description, example, enumTitles, sectionCaption, sectionDescription).
 */
export const isNonfunctionalJsonChange = (oldContent: string, newContent: string): boolean => {
    let oldJson: unknown;
    let newJson: unknown;
    try {
        oldJson = JSON.parse(oldContent);
        newJson = JSON.parse(newContent);
    } catch {
        return false;
    }
    return isNonfunctionalChange(oldJson, newJson);
};

/**
 * Given the commit range and a list of changed file paths, returns a Set of lowercase file paths
 * for JSON files where only non-functional fields (title, description, example, etc.) changed.
 * These files should only trigger a latest build, not test runs.
 */
export const findFilesWithNonfunctionalChanges = (commits: Commit[], filepathsChanged: string[]): Set<string> => {
    const result = new Set<string>();
    if (commits.length === 0) return result;

    const jsonFiles = filepathsChanged.filter((f) => {
        const lower = f.toLowerCase();
        return lower.endsWith('.json')
            && (lower.startsWith('actors/') || lower.startsWith('standalone-actors/'));
    });
    if (jsonFiles.length === 0) return result;

    const oldRef = `${commits[0].sha}~`;
    const newRef = commits[commits.length - 1].sha;

    for (const filepath of jsonFiles) {
        try {
            const oldContent = spawnCommandInGhWorkspace(`git show ${oldRef}:${filepath}`);
            const newContent = spawnCommandInGhWorkspace(`git show ${newRef}:${filepath}`);
            if (isNonfunctionalJsonChange(oldContent, newContent)) {
                result.add(filepath.toLowerCase());
            }
        } catch {
            // File is new, deleted, or unreadable at one of the refs — treat as functional
        }
    }

    return result;
};
