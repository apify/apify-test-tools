import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    assertRelative,
    findContainingScope,
    hoistPath,
    isParentOf,
    isPathWithinScope,
    isSamePath,
} from '../../../bin/path-utils.js';

describe('isPathWithinScope', () => {
    it('matches a scope entry that names an exact file, not just a directory prefix', () => {
        expect(isPathWithinScope('shared/utils.ts', 'shared/utils.ts')).toBe(true);
    });
});

describe('findContainingScope', () => {
    it('picks the exact-file entry out of a list of scope paths', () => {
        expect(findContainingScope('shared/utils.ts', ['actors/foo', 'shared/utils.ts'])).toBe('shared/utils.ts');
    });
});

describe('hoistPath', () => {
    it('resolves an exact-file scope match to an empty string, not an out-of-bounds slice', () => {
        expect(hoistPath('shared/utils.ts', 'shared/utils.ts')).toBe('');
    });
});

describe('isParentOf', () => {
    it('accepts a direct child', () => {
        expect(isParentOf('actors/foo', 'actors/foo/main.ts')).toBe(true);
    });

    it('accepts a deep descendant', () => {
        expect(isParentOf('actors/foo', 'actors/foo/src/lib/deep.ts')).toBe(true);
    });

    it('rejects a path outside the parent', () => {
        expect(isParentOf('actors/foo', 'actors/bar/main.ts')).toBe(false);
    });

    it('rejects the parent itself when the arguments are swapped', () => {
        expect(isParentOf('actors/foo/src', 'actors/foo')).toBe(false);
    });

    // The classic `startsWith(prefix)` bug: `actors/foobar` is not inside `actors/foo`.
    // `relative()` gives `../foobar` here, so this case is handled correctly.
    it('rejects a sibling whose name merely starts with the parent name', () => {
        expect(isParentOf('actors/foo', 'actors/foobar/main.ts')).toBe(false);
    });

    it('returns false when the paths are equivalent', () => {
        expect(isParentOf('actors/foo', './actors/foo')).toBe(false);
    });

    it('normalizes redundant segments before comparing', () => {
        expect(isParentOf('actors/foo', 'actors/bar/../foo/main.ts')).toBe(true);
        expect(isParentOf('./actors/foo', 'actors/foo/main.ts')).toBe(true);
    });

    it('accepts dotfiles inside the parent', () => {
        expect(isParentOf('actors/foo', 'actors/foo/.actor/actor.json')).toBe(true);
    });

    it('accepts a genuine child whose basename starts with ".."', () => {
        expect(isParentOf('actors/foo', 'actors/foo/..foo')).toBe(true);
        expect(isParentOf('actors/foo', 'actors/foo/...rc')).toBe(true);
    });

    it('rejects absolute paths by throwing an error', () => {
        expect(() => isParentOf(process.cwd(), 'actors/foo')).toThrow();
        expect(() => isParentOf('/some/unrelated/dir', 'actors/foo')).toThrow();
    });
});

describe('isSamePath', () => {
    it('accepts two identical paths', () => {
        expect(isSamePath('actors/foo/main.ts', 'actors/foo/main.ts')).toBe(true);
    });

    it('rejects two different paths', () => {
        expect(isSamePath('actors/foo/main.ts', 'actors/bar/main.ts')).toBe(false);
    });

    it('rejects a parent/child pair', () => {
        expect(isSamePath('actors/foo', 'actors/foo/main.ts')).toBe(false);
    });

    it('rejects a sibling whose name merely starts with the other name', () => {
        expect(isSamePath('actors/foo', 'actors/foobar')).toBe(false);
    });

    it('treats equivalent spellings of the same path as equal', () => {
        expect(isSamePath('./actors/foo', 'actors/foo')).toBe(true);
        expect(isSamePath('actors/foo/', 'actors/foo')).toBe(true);
        expect(isSamePath('actors/foo', 'actors/bar/../foo')).toBe(true);
    });

    it('is case-sensitive on POSIX', () => {
        expect(isSamePath('actors/Foo', 'actors/foo')).toBe(false);
    });

    it('rejects absolute paths by throwing an error', () => {
        expect(() => isSamePath('actors/foo', join(process.cwd(), 'actors/foo'))).toThrow();
    });
});

describe('assertRelative', () => {
    it('accepts a relative path', () => {
        expect(() => assertRelative('actors/foo/.actor/actor.json')).not.toThrow();
    });

    // `resolveConfigFilePaths` feeds it `dirname(configFilePath)`, which is `'.'` for a config file
    // sitting at the repo root — the most common input in practice.
    it('accepts "." as produced by dirname() on a bare filename', () => {
        expect(() => assertRelative('.')).not.toThrow();
    });

    it('accepts an empty string', () => {
        expect(() => assertRelative('')).not.toThrow();
    });

    it('throws on an absolute path, naming the offending path', () => {
        expect(() => assertRelative('/etc/apify-test-tools.config.json')).toThrow(
            new Error('Expected /etc/apify-test-tools.config.json to be relative'),
        );
    });

    it('throws on the root path', () => {
        expect(() => assertRelative('/')).toThrow(/to be relative/);
    });

    it('returns undefined when the path is acceptable', () => {
        expect(assertRelative('actors/foo')).toBeUndefined();
    });

    // Deliberate scoping note, not a bug: the guard only asserts "not absolute". A relative path is
    // still free to escape the repo root, and `resolveConfigFilePaths` will happily `join()` it.
    it('does not reject a relative path that escapes upwards', () => {
        expect(() => assertRelative('../../etc/passwd')).not.toThrow();
    });
});
