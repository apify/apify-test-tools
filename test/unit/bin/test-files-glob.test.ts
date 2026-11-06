import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestFilesMatcher, resolveTestFilesGlob } from '../../../bin/test-files-glob.js';

describe('createTestFilesMatcher', () => {
    it('matches repo-root-relative paths, ignoring case and including dot files', () => {
        const isMatch = createTestFilesMatcher('test/platform/{daily,hourly}/**');
        expect(isMatch('test/platform/daily/a.test.ts')).toBe(true);
        expect(isMatch('Test/Platform/Hourly/.b.test.ts')).toBe(true);
        expect(isMatch('test/platform/daily-without-pr/a.test.ts')).toBe(false);
        expect(isMatch('test/platform/utils.ts')).toBe(false);
    });

    it('matches nothing without a glob', () => {
        expect(createTestFilesMatcher(undefined)('test/platform/a.test.ts')).toBe(false);
    });

    it('rejects an absolute glob', () => {
        expect(() => createTestFilesMatcher('/repo/test/platform/**')).toThrow('must be relative to the repo root');
    });
});

describe('resolveTestFilesGlob', () => {
    let repoDir: string;

    beforeAll(async () => {
        repoDir = await mkdtemp(path.join(os.tmpdir(), 'apify-test-files-glob-'));
        for (const file of [
            'test/platform/utils.ts',
            'test/platform/daily/a.test.ts',
            'test/platform/daily-without-pr/b.test.ts',
            'test/platform/hourly/nested/c.test.ts',
            'test/platform/node_modules/d.test.ts',
            'other/test/platform/daily/e.test.ts',
        ]) {
            await mkdir(path.join(repoDir, path.dirname(file)), { recursive: true });
            await writeFile(path.join(repoDir, file), '');
        }
    });

    afterAll(async () => {
        if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    it('lists the matched files from the repo root, sorted, skipping node_modules', async () => {
        expect(await resolveTestFilesGlob('test/platform/**', repoDir)).toEqual([
            'test/platform/daily-without-pr/b.test.ts',
            'test/platform/daily/a.test.ts',
            'test/platform/hourly/nested/c.test.ts',
            'test/platform/utils.ts',
        ]);
    });

    it('selects folders with a brace pattern', async () => {
        expect(await resolveTestFilesGlob('test/platform/{daily,hourly}/**', repoDir)).toEqual([
            'test/platform/daily/a.test.ts',
            'test/platform/hourly/nested/c.test.ts',
        ]);
    });

    it('accepts a leading ./', async () => {
        expect(await resolveTestFilesGlob('./test/platform/daily/**', repoDir)).toEqual([
            'test/platform/daily/a.test.ts',
        ]);
    });

    it('walks the whole repo when the glob has no static base', async () => {
        expect(await resolveTestFilesGlob('**/daily/*.test.ts', repoDir)).toEqual([
            'other/test/platform/daily/e.test.ts',
            'test/platform/daily/a.test.ts',
        ]);
    });

    it('matches no file with a glob relative to test/platform or a folder without **', async () => {
        expect(await resolveTestFilesGlob('daily/**', repoDir)).toEqual([]);
        expect(await resolveTestFilesGlob('test/platform/daily', repoDir)).toEqual([]);
    });
});
