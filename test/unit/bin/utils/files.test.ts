import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { safeReadJsonObjectFile } from '../../../../bin/utils/files.js';

// These tests read real fixture files rather than mocking `node:fs/promises`: the whole point of
// `safeReadJsonObjectFile` is how it reacts to real stat/readFile outcomes (missing path, directory,
// symlink, unreadable file), so mocking those away would only assert the mock back to itself.
const FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/bin/utils/files/', import.meta.url));

const fixture = (name: string) => path.join(FIXTURE_DIR, name);

const NESTED_FIXTURE = {
    storages: { datasets: { default: { title: 'Default' } } },
    overrideActorContext: ['../shared', '.'],
    changelog: null,
    nested: [{ deep: [1, 2, { deeper: true }] }],
};

describe('safeReadJsonObjectFile', () => {
    describe('valid JSON objects', () => {
        it('returns the parsed contents, preserving nested objects, arrays and null values', async () => {
            const result = await safeReadJsonObjectFile(fixture('nested.json'));

            expect(result).toStrictEqual({ success: true, contents: NESTED_FIXTURE });
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
            const filePath = fixture('does-not-exist.json');

            const result = await safeReadJsonObjectFile(filePath);

            expect(result).toStrictEqual({
                success: false,
                reason: 'missing',
                failure: new Error(`Expected ${filePath} to exist`),
            });
        });

        // The fixture is named `directory.json` on purpose — the check is `stat().isFile()`, not the extension.
        it('fails when the path is a directory', async () => {
            const filePath = fixture('directory.json');

            const result = await safeReadJsonObjectFile(filePath);

            expect(result).toStrictEqual({
                success: false,
                reason: 'not-a-file',
                failure: new Error(`Expected ${filePath} to be a file`),
            });
        });

        // Regression guard: `lstat` would report the link itself as "not a file" and reject it, even
        // though `readFile` follows symlinks and would have read the target without complaint.
        it('follows a symlink to its target file', async () => {
            const result = await safeReadJsonObjectFile(fixture('symlink-to-valid.json'));

            expect(result).toStrictEqual({ success: true, contents: NESTED_FIXTURE });
        });

        // Git only tracks the executable bit, so this is the one case whose fixture cannot carry its own
        // mode — `unreadable.json` is committed readable and stripped of permissions just for this test.
        describe('unreadable file', () => {
            const filePath = fixture('unreadable.json');

            afterEach(async () => fs.chmod(filePath, 0o644));

            it.runIf(process.getuid?.() !== 0)('fails when the file exists but cannot be read', async () => {
                await fs.chmod(filePath, 0o000);

                const result = await safeReadJsonObjectFile(filePath);

                expect(result).toStrictEqual({
                    success: false,
                    reason: 'unreadable',
                    failure: new Error(`Failed to read ${filePath}`),
                });
            });
        });
    });

    describe('JSON that is not an object', () => {
        it('rejects a JSON array', async () => {
            const filePath = fixture('array.json');

            const result = await safeReadJsonObjectFile(filePath);

            expect(result).toStrictEqual({
                success: false,
                reason: 'not-an-object',
                failure: new Error(`Expected ${filePath} to be a JSON object, not an array`),
            });
        });

        it('rejects JSON null', async () => {
            const filePath = fixture('null.json');

            const result = await safeReadJsonObjectFile(filePath);

            expect(result).toStrictEqual({
                success: false,
                reason: 'not-an-object',
                failure: new Error(`Expected ${filePath} to be a JSON object, not null`),
            });
        });

        it('rejects a JSON primitive', async () => {
            const filePath = fixture('number.json');

            const result = await safeReadJsonObjectFile(filePath);

            expect(result).toStrictEqual({
                success: false,
                reason: 'not-an-object',
                failure: new Error(`Expected ${filePath} to be a JSON object`),
            });
        });
    });

    describe('unparseable files', () => {
        it('fails on malformed JSON', async () => {
            const filePath = fixture('malformed.json');

            const result = await safeReadJsonObjectFile(filePath);

            expect(result).toMatchObject({ success: false, reason: 'invalid-json' });
            expect((result as { failure: Error }).failure.message).toContain(`Failed to parse ${filePath}`);
        });

        it('fails on an empty file', async () => {
            const filePath = fixture('empty.json');

            const result = await safeReadJsonObjectFile(filePath);

            expect(result).toMatchObject({ success: false, reason: 'invalid-json' });
            expect((result as { failure: Error }).failure.message).toContain(`Failed to parse ${filePath}`);
        });
    });
});
