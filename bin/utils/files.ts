import { readFile, stat } from 'node:fs/promises';

// this function structure blows, but i wanted to keep errors transparent
export async function safeReadJsonObjectFile(
    path: string,
): Promise<{ success: true; contents: Record<string, unknown> } | { success: false; failure: Error }> {
    // `stat` since symlinks must resolve to their target, matching what `readFile` below does
    const stats = await stat(path).catch(() => null);
    if (!stats) {
        return { success: false, failure: new Error(`Expected ${path} to exist`) };
    }
    if (!stats.isFile()) {
        return { success: false, failure: new Error(`Expected ${path} to be a file`) };
    }
    const file = await readFile(path, 'utf8').catch(() => null);

    if (file === null) {
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
