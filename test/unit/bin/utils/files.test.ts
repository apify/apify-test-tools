import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { safeReadJsonObjectFile } from '../../../../bin/utils/json-file.js';
import { ExistingFile } from '../../../../bin/utils/path/repo-relative.js';

// These tests read real fixture files rather than mocking `node:fs`. Existence and file-kind checks
// happen when constructing ExistingFile; this reader tests JSON parsing and read failures after that.
const FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/bin/utils/files/', import.meta.url));

let originalCwd: string;

beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(FIXTURE_DIR);
});

afterEach(() => process.chdir(originalCwd));

const fixture = (name: string): ExistingFile => new ExistingFile(name);

const NESTED_FIXTURE = {
    storages: { datasets: { default: { title: 'Default' } } },
    overrideActorContext: ['../shared', '.'],
    changelog: null,
    nested: [{ deep: [1, 2, { deeper: true }] }],
};

describe('safeReadJsonObjectFile', () => {
    describe('valid JSON objects', () => {
        it('returns the parsed contents, preserving nested objects, arrays and null values', () => {
            const result = safeReadJsonObjectFile(fixture('nested.json'));

            expect(result).toStrictEqual({ success: true, contents: NESTED_FIXTURE });
        });

        it('accepts an empty JSON object', () => {
            const result = safeReadJsonObjectFile(fixture('empty-object.json'));

            expect(result).toStrictEqual({ success: true, contents: {} });
        });

        it('reads files that are not named *.json', () => {
            const result = safeReadJsonObjectFile(fixture('no-json-extension.actorrc'));

            expect(result).toStrictEqual({ success: true, contents: { a: 1 } });
        });
    });

    describe('filesystem-level handling', () => {
        // Regression guard: `lstat` would report the link itself as "not a file" and reject it, even
        // though `readFile` follows symlinks and would have read the target without complaint.
        it('follows a symlink to its target file', () => {
            const result = safeReadJsonObjectFile(fixture('symlink-to-valid.json'));

            expect(result).toStrictEqual({ success: true, contents: NESTED_FIXTURE });
        });

        // Git only tracks the executable bit, so this is the one case whose fixture cannot carry its own
        // mode — `unreadable.json` is committed readable and stripped of permissions just for this test.
        describe('unreadable file', () => {
            const filePath = 'unreadable.json';

            afterEach(async () => fs.chmod(filePath, 0o644));

            it.runIf(process.getuid?.() !== 0)('fails when the file exists but cannot be read', async () => {
                const file = fixture(filePath);
                await fs.chmod(filePath, 0o000);

                const result = safeReadJsonObjectFile(file);

                expect(result).toMatchObject({
                    success: false,
                    reason: 'unreadable',
                });
            });
        });
    });

    describe('JSON that is not an object', () => {
        it('rejects a JSON array', () => {
            const filePath = fixture('array.json');

            const result = safeReadJsonObjectFile(filePath);

            expect(result).toMatchObject({
                success: false,
                reason: 'not-an-object',
            });
        });

        it('rejects JSON null', () => {
            const filePath = fixture('null.json');

            const result = safeReadJsonObjectFile(filePath);

            expect(result).toMatchObject({
                success: false,
                reason: 'not-an-object',
            });
        });

        it('rejects a JSON primitive', () => {
            const filePath = fixture('number.json');

            const result = safeReadJsonObjectFile(filePath);

            expect(result).toMatchObject({
                success: false,
                reason: 'not-an-object',
            });
        });
    });

    describe('unparseable files', () => {
        it('fails on malformed JSON', () => {
            const filePath = fixture('malformed.json');

            const result = safeReadJsonObjectFile(filePath);

            expect(result).toMatchObject({ success: false, reason: 'invalid-json' });
            expect((result as { failure: Error }).failure.message).toContain(`Failed to parse ${filePath.path}`);
        });

        it('fails on an empty file', () => {
            const filePath = fixture('empty.json');

            const result = safeReadJsonObjectFile(filePath);

            expect(result).toMatchObject({ success: false, reason: 'invalid-json' });
            expect((result as { failure: Error }).failure.message).toContain(`Failed to parse ${filePath.path}`);
        });

        it.fails('reads jsonc', () => {
            const filePath = fixture('comments.jsonc');

            const result = safeReadJsonObjectFile(filePath);

            expect(result).toMatchObject({ success: true, contents: { a: 3 } });
        });
    });
});
