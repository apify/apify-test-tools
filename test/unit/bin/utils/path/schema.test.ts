import { describe, expect, it } from 'vitest';

import { ExistingFile, RelativeDir, RelativeFile } from '../../../../../bin/utils/path/repo-relative.js';
import { ExistingFileSchema, RelativeDirSchema, RelativeFileSchema } from '../../../../../bin/utils/path/schema.js';

describe('RelativeDirSchema', () => {
    it('normalizes a repo-relative directory', () => {
        const parsed = RelativeDirSchema.parse('./actors//shop/');
        expect(parsed).toBeInstanceOf(RelativeDir);
        expect(parsed.path).toBe('actors/shop');
        expect(RelativeDirSchema.parse('')).toEqual(RelativeDir.ROOT);
    });

    it('rejects paths outside the repo and non-string input', () => {
        expect(RelativeDirSchema.safeParse('../outside').success).toBe(false);
        expect(RelativeDirSchema.safeParse('/absolute').success).toBe(false);
        expect(RelativeDirSchema.safeParse(123).success).toBe(false);
    });
});

describe('RelativeFileSchema', () => {
    it('normalizes a repo-relative file', () => {
        const parsed = RelativeFileSchema.parse('./actors//shop/actor.json');
        expect(parsed).toBeInstanceOf(RelativeFile);
        expect(parsed.path).toBe('actors/shop/actor.json');
    });

    it('rejects directory paths, paths outside the repo, and non-string input', () => {
        for (const value of ['', '.', 'actors/shop/', '../outside.json', '/absolute.json', 123]) {
            expect(RelativeFileSchema.safeParse(value).success).toBe(false);
        }
    });
});

describe('ExistingFileSchema', () => {
    it('parses an existing file', () => {
        const parsed = ExistingFileSchema.parse('./package.json');
        expect(parsed).toBeInstanceOf(ExistingFile);
        expect(parsed.path).toBe('package.json');
    });

    it('rejects missing files and directories', () => {
        expect(ExistingFileSchema.safeParse('missing.txt').success).toBe(false);
        expect(ExistingFileSchema.safeParse('bin').success).toBe(false);
    });
});
