import { describe, expect, it } from 'vitest';

import { createTestFileMatcher } from '../../../bin/test-files.js';

describe('createTestFileMatcher', () => {
    it('matches everything under test/platform by default', () => {
        const isTestFile = createTestFileMatcher();
        expect(isTestFile('test/platform/daily/foo.test.ts')).toBe(true);
        expect(isTestFile('test/platform/helpers.ts')).toBe(true);
        expect(isTestFile('test/unit/foo.test.ts')).toBe(false);
        expect(isTestFile('src/test/platform/foo.ts')).toBe(false);
    });

    it('matches case-insensitively', () => {
        expect(createTestFileMatcher()('Test/Platform/Foo.test.ts')).toBe(true);
    });

    it('supports braces, like the legacy test-files-glob input', () => {
        const isTestFile = createTestFileMatcher('test/platform/{daily,hourly}/**');
        expect(isTestFile('test/platform/daily/a.test.ts')).toBe(true);
        expect(isTestFile('test/platform/hourly/nested/b.test.ts')).toBe(true);
        expect(isTestFile('test/platform/known-broken/c.test.ts')).toBe(false);
    });

    it('supports test files spread across the repo', () => {
        const isTestFile = createTestFileMatcher('**/*.platform.test.ts');
        expect(isTestFile('actors/foo/src/main.platform.test.ts')).toBe(true);
        expect(isTestFile('main.platform.test.ts')).toBe(true);
        expect(isTestFile('actors/foo/src/main.test.ts')).toBe(false);
    });

    it('works as an Array.filter callback', () => {
        expect(['test/platform/a.test.ts', 'src/main.ts'].filter(createTestFileMatcher())).toStrictEqual([
            'test/platform/a.test.ts',
        ]);
    });
});
