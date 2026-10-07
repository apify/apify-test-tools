import { readFileSync } from 'node:fs';

import type { ExistingFile } from './path/repo-relative.js';

/**
 * Why a JSON object could not be produced from a path. Callers that already have their own
 * user-facing wording (e.g. the config file reader) switch on this instead of re-deriving the
 * cause from an error message.
 */
export type JsonObjectReadFailureReason = 'unreadable' | 'invalid-json' | 'not-an-object';

export type JsonObjectReadResult =
    | { success: true; contents: Record<string, unknown> }
    | { success: false; reason: JsonObjectReadFailureReason; failure: Error };

const failed = (reason: JsonObjectReadFailureReason, message: string): JsonObjectReadResult => ({
    success: false,
    reason,
    failure: new Error(message),
});

/**
 * Reads a file and parses it as a JSON object, reporting every way that can go wrong as a value
 * instead of a thrown error — the caller decides which failures are fatal and how to word them.
 */
export function safeReadJsonObjectFile(filePath: ExistingFile): JsonObjectReadResult {
    let file: string;
    try {
        file = readFileSync(filePath.path, 'utf8');
    } catch {
        return failed('unreadable', `Expected ${filePath} to exist or be readable`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(file);
    } catch (err) {
        return failed('invalid-json', `Failed to parse ${filePath}: ${err}`);
    }

    if (parsed === null) {
        return failed('not-an-object', `Expected ${filePath} to be a JSON object, not null`);
    }
    if (Array.isArray(parsed)) {
        return failed('not-an-object', `Expected ${filePath} to be a JSON object, not an array`);
    }
    if (typeof parsed !== 'object') {
        return failed('not-an-object', `Expected ${filePath} to be a JSON object`);
    }

    return { success: true, contents: parsed as Record<string, unknown> };
}
