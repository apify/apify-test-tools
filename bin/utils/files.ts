import { lstat, readFile } from 'node:fs/promises';

// this function structure blows, but i wanted to keep errors transparent
export async function safeReadJsonObjectFile(
    path: string,
): Promise<{ success: true; contents: Record<string, unknown> } | { success: false; failure: Error }> {
    const stat = await lstat(path).catch(() => null);
    if (!stat) {
        return { success: false, failure: new Error(`Expected ${path} to exist`) };
    }
    if (!stat.isFile()) {
        return { success: false, failure: new Error(`Expected ${path} to be a file`) };
    }
    const file = await readFile(path, 'utf8').catch(() => null);
    if (!file) {
        return { success: false, failure: new Error(`Failed to read ${path}`) };
    }
    try {
        const parsed = JSON.parse(file);
        if (typeof parsed !== 'object') {
            return { success: false, failure: new Error(`Expected ${path} to be a JSON object`) };
        }
        if (Array.isArray(parsed)) {
            return { success: false, failure: new Error(`Expected ${path} to be a JSON object, not an array`) };
        }
        if (parsed === null) {
            return { success: false, failure: new Error(`Expected ${path} to be a JSON object, not null`) };
        }
        return { contents: parsed, success: true };
    } catch (err) {
        return { success: false, failure: new Error(`Failed to parse ${path}: ${err}`) };
    }
}
