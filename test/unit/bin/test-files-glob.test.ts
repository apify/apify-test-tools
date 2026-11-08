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

    const files = async (glob: string) => (await resolveTestFilesGlob(glob, repoDir)).files;
    const paths = async (glob: string) => (await resolveTestFilesGlob(glob, repoDir)).paths;

    it('lists the matched files from the repo root, sorted, skipping node_modules', async () => {
        expect(await files('test/platform/**')).toEqual([
            'test/platform/daily-without-pr/b.test.ts',
            'test/platform/daily/a.test.ts',
            'test/platform/hourly/nested/c.test.ts',
            'test/platform/utils.ts',
        ]);
    });

    it('selects folders with a brace pattern', async () => {
        expect(await files('test/platform/{daily,hourly}/**')).toEqual([
            'test/platform/daily/a.test.ts',
            'test/platform/hourly/nested/c.test.ts',
        ]);
    });

    it('accepts a leading ./', async () => {
        expect(await files('./test/platform/daily/**')).toEqual(['test/platform/daily/a.test.ts']);
    });

    it('walks the whole repo when the glob has no static base', async () => {
        expect(await files('**/daily/*.test.ts')).toEqual([
            'other/test/platform/daily/e.test.ts',
            'test/platform/daily/a.test.ts',
        ]);
    });

    it('resolves a glob without wildcards to the file itself', async () => {
        expect(await resolveTestFilesGlob('test/platform/utils.ts', repoDir)).toStrictEqual({
            files: ['test/platform/utils.ts'],
            paths: ['test/platform/utils.ts'],
        });
    });

    it('matches no file with a glob relative to test/platform or a folder without **', async () => {
        expect(await files('daily/**')).toEqual([]);
        expect(await files('test/platform/daily')).toEqual([]);
    });

    it('gives a folder whose files all match as one path, ending with / so it is not a prefix of a sibling', async () => {
        expect(await paths('test/platform/{daily,hourly}/**')).toEqual([
            'test/platform/daily/',
            'test/platform/hourly/',
        ]);
    });

    it('lists the matched files one by one in a folder that also holds files the glob leaves out', async () => {
        // test/platform/utils.ts is left out, so test/platform/ can't be one path
        expect(await paths('test/platform/**/*.test.ts')).toEqual([
            'test/platform/daily-without-pr/',
            'test/platform/daily/',
            'test/platform/hourly/',
        ]);
        // other/ holds only the matched file, so it is the highest folder that can be one path
        expect(await paths('**/daily/*.test.ts')).toEqual(['other/', 'test/platform/daily/']);
    });

    it('never gives a folder that holds a skipped node_modules as one path', async () => {
        // test/platform/node_modules/ is not walked, so test/platform/ might hold files the glob leaves out
        expect(await paths('test/platform/**')).toEqual([
            'test/platform/daily-without-pr/',
            'test/platform/daily/',
            'test/platform/hourly/',
            'test/platform/utils.ts',
        ]);
    });
});
