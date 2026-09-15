import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { safeReadJsonObjectFile } from '../../../../bin/utils/files.js';
import nestedFixture from '../../../fixtures/bin/utils/files/nested.json' with { type: 'json' };

// These tests read real fixture files rather than mocking `node:fs/promises`: the whole point of
// `safeReadJsonObjectFile` is how it reacts to real lstat/readFile outcomes (missing path, directory,
// symlink, unreadable file), so mocking those away would only assert the mock back to itself.
const FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/bin/utils/files/', import.meta.url));

const fixture = (name: string) => path.join(FIXTURE_DIR, name);

describe('safeReadJsonObjectFile', () => {
    describe('valid JSON objects', () => {
        it('returns the parsed contents, preserving nested objects, arrays and null values', async () => {
            const filePath = fixture('nested.json');

            const result = await safeReadJsonObjectFile(filePath);

            expect(result).toStrictEqual({
                success: true,
                contents: nestedFixture,
            });
        });

        it('accepts an empty JSON object', async () => {
            const result = await safeReadJsonObjectFile(fixture('empty-object.json'));

            expect(result).toStrictEqual({ success: true, contents: {} });
        });

        it('reads files that are not named *.json', async () => {
            const result = await safeReadJsonObjectFile(fixture('no-json-extension.actorrc'));

            expect(result).toStrictEqual({ success: true, contents: { a: 1 } });
        });
    });

    describe('filesystem-level handling', () => {
        it('fails when the path does not exist', async () => {
            const missingPath = fixture('does-not-exist.json');

            const result = await safeReadJsonObjectFile(missingPath);

            expect(result).toStrictEqual({ success: false, failure: new Error(`Expected ${missingPath} to exist`) });
        });

        // The fixture is named `directory.json` on purpose — the check is `lstat().isFile()`, not the extension.
        it('fails when the path is a directory', async () => {
            const dirPath = fixture('directory.json');

            const result = await safeReadJsonObjectFile(dirPath);

            expect(result).toStrictEqual({ success: false, failure: new Error(`Expected ${dirPath} to be a file`) });
        });

        // Regression guard: `lstat` would report the link itself as "not a file" and reject it, even
        // though `readFile` follows symlinks and would have read the target without complaint.
        it('follows a symlink to its target file', async () => {
            const result = await safeReadJsonObjectFile(fixture('symlink-to-valid.json'));

            expect(result).toStrictEqual({ success: true, contents: nestedFixture });
        });

        // Git only tracks the executable bit, so this is the one case whose fixture cannot carry its own
        // mode — `unreadable.json` is committed readable and stripped of permissions just for this test.
        describe('unreadable file', () => {
            const filePath = fixture('unreadable.json');

            afterEach(async () => fs.chmod(filePath, 0o644));

            it.runIf(process.getuid?.() !== 0)('fails when the file exists but cannot be read', async () => {
                await fs.chmod(filePath, 0o000);

                const result = await safeReadJsonObjectFile(filePath);

                expect(result).toStrictEqual({ success: false, failure: new Error(`Failed to read ${filePath}`) });
            });
        });
    });

    describe('JSON that is not an object', () => {
        it('rejects a JSON array', async () => {
            const filePath = fixture('array.json');

            const result = await safeReadJsonObjectFile(filePath);

            expect(result).toStrictEqual({
                success: false,
                failure: new Error(`Expected ${filePath} to be a JSON object, not an array`),
            });
        });

        it('rejects JSON null', async () => {
            const filePath = fixture('null.json');

            const result = await safeReadJsonObjectFile(filePath);

            expect(result).toStrictEqual({
                success: false,
                failure: new Error(`Expected ${filePath} to be a JSON object, not null`),
            });
        });

        it('rejects a JSON primitive', async () => {
            const filePath = fixture('number.json');

            const result = await safeReadJsonObjectFile(filePath);

            expect(result).toStrictEqual({
                success: false,
                failure: new Error(`Expected ${filePath} to be a JSON object`),
            });
        });
    });

    describe('unparseable files', () => {
        it('fails on malformed JSON', async () => {
            const filePath = fixture('malformed.json');

            const result = await safeReadJsonObjectFile(filePath);

            expect(result.success).toBe(false);
            expect((result as { failure: Error }).failure.message).toContain(`Failed to parse ${filePath}`);
        });

        it('fails on an empty file', async () => {
            const filePath = fixture('empty.json');

            const result = await safeReadJsonObjectFile(filePath);

            expect(result.success).toBe(false);
            expect((result as { failure: Error }).failure.message).toContain(`Failed to parse ${filePath}`);
        });
    });
});
