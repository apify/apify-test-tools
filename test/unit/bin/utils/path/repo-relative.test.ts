import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RelativePath } from '../../../../../bin/utils/path/repo-relative.js';

// Paths from the config file and from git all enter through the root.
const parse = (raw: string): RelativePath => RelativePath.ROOT.join(raw);

describe('RelativePath', () => {
    describe('ROOT', () => {
        it('is a RelativePath spelled "."', () => {
            expect(RelativePath.ROOT).toBeInstanceOf(RelativePath);
            expect(RelativePath.ROOT.toString()).toBe('.');
        });

        it.each(['', '.', './', './/', 'a/..'])('is what %j parses to', (raw) => {
            expect(parse(raw).isEqualTo(RelativePath.ROOT)).toBe(true);
            expect(parse(raw).toString()).toBe('.');
        });
    });

    describe('parsing (ROOT.join)', () => {
        it.each(['actors/foo', './actors/foo', 'actors/foo/', 'actors//foo', './actors/./foo//', 'actors/bar/../foo'])(
            'normalizes %j to actors/foo',
            (raw) => {
                expect(parse(raw).toString()).toBe('actors/foo');
            },
        );

        it.each(['..', '../x', 'actors/../../x', './..'])('rejects %j because it escapes the repo root', (raw) => {
            expect(() => parse(raw)).toThrow('escapes the repo root');
        });

        it('rejects absolute paths', () => {
            expect(() => parse('/etc/passwd')).toThrow('got absolute path "/etc/passwd"');
        });

        it('rejects absolute paths even when they point inside the working directory', () => {
            expect(() => parse(path.join(process.cwd(), 'actors/foo'))).toThrow('got absolute path');
        });

        it('reports the path as written, not its normalized form', () => {
            expect(() => parse('a/../../x')).toThrow();
        });

        it('keeps a directory named "..foo", which does not escape the repo root', () => {
            expect(parse('..foo/bar').toString()).toBe('..foo/bar');
        });

        it('keeps case, since git paths are case-sensitive', () => {
            expect(parse('Actors/Foo').isEqualTo(parse('actors/foo'))).toBe(false);
        });
    });

    describe('join', () => {
        const actorDir = parse('actors/foo');
        const actorDotDir = parse('actors/foo/.actor');

        it('resolves relative to the path it is called on', () => {
            expect(actorDir.join('src').toString()).toBe('actors/foo/src');
            expect(actorDir.join('src/main.ts').toString()).toBe('actors/foo/src/main.ts');
        });

        it('resolves a dockerContextDir the way actor.json means it', () => {
            expect(actorDotDir.join('..').toString()).toBe('actors/foo');
            expect(actorDotDir.join('../..').toString()).toBe('actors');
            expect(actorDotDir.join('../../..').isEqualTo(RelativePath.ROOT)).toBe(true);
            expect(actorDotDir.join('./Dockerfile').toString()).toBe('actors/foo/.actor/Dockerfile');
        });

        it('can climb out of the path it is called on, as long as it stays within the repo root', () => {
            expect(actorDir.join('../bar').toString()).toBe('actors/bar');
        });

        it('rejects results that escape the repo root', () => {
            expect(() => actorDotDir.join('../../../..')).toThrow('escapes the repo root');
        });

        it('does not depend on the process working directory', () => {
            const originalCwd = process.cwd();
            try {
                process.chdir(path.join(originalCwd, 'bin'));
                expect(parse('actors/foo').toString()).toBe('actors/foo');
                expect(actorDir.join('src').toString()).toBe('actors/foo/src');
            } finally {
                process.chdir(originalCwd);
            }
        });
    });

    describe('isEqualTo', () => {
        it('matches different spellings of the same path', () => {
            expect(parse('./actors/foo/').isEqualTo(parse('actors/foo'))).toBe(true);
        });

        it('does not match different paths', () => {
            expect(parse('actors/foo').isEqualTo(parse('actors/foobar'))).toBe(false);
        });
    });

    describe('isStrictAncestorOf', () => {
        const foo = parse('actors/foo');

        it('is true for paths inside it', () => {
            expect(foo.isStrictAncestorOf(parse('actors/foo/src/main.ts'))).toBe(true);
        });

        it('is false for itself', () => {
            expect(foo.isStrictAncestorOf(foo)).toBe(false);
        });

        it('is false for a sibling that shares a name prefix', () => {
            expect(foo.isStrictAncestorOf(parse('actors/foobar'))).toBe(false);
        });

        it('makes the root an ancestor of every other path', () => {
            expect(RelativePath.ROOT.isStrictAncestorOf(foo)).toBe(true);
            expect(RelativePath.ROOT.isStrictAncestorOf(parse('README.md'))).toBe(true);
            expect(RelativePath.ROOT.isStrictAncestorOf(RelativePath.ROOT)).toBe(false);
        });
    });

    describe('isWithin', () => {
        const foo = parse('actors/foo');

        it('matches the scope itself and paths inside it', () => {
            expect(foo.isWithin(foo)).toBe(true);
            expect(parse('actors/foo/src/main.ts').isWithin(foo)).toBe(true);
        });

        it('matches a scope that names an exact file', () => {
            const file = parse('shared/utils.ts');
            expect(file.isWithin(file)).toBe(true);
        });

        it('does not match a sibling that shares a name prefix', () => {
            expect(parse('actors/foobar/main.ts').isWithin(foo)).toBe(false);
        });

        it('treats every path as within the root', () => {
            expect(foo.isWithin(RelativePath.ROOT)).toBe(true);
            expect(parse('README.md').isWithin(RelativePath.ROOT)).toBe(true);
            expect(RelativePath.ROOT.isWithin(RelativePath.ROOT)).toBe(true);
        });

        it('does not treat the root as within a subfolder', () => {
            expect(RelativePath.ROOT.isWithin(foo)).toBe(false);
        });
    });

    describe('string output', () => {
        it('renders as the path in templates', () => {
            expect(`${parse('actors/foo')}/x`).toBe('actors/foo/x');
        });

        it('renders as a plain string in JSON', () => {
            expect(JSON.stringify({ folder: parse('actors/foo'), root: RelativePath.ROOT })).toBe(
                '{"folder":"actors/foo","root":"."}',
            );
        });
    });

    // Git and the config file always use "/", so paths must not change spelling with the host OS.
    describe('on Windows', () => {
        afterEach(() => {
            vi.doUnmock('node:path');
            vi.resetModules();
        });

        const importWithWin32Path = async (): Promise<typeof RelativePath> => {
            vi.resetModules();
            vi.doMock('node:path', () => ({ default: path.win32, ...path.win32 }));
            const module = await import('../../../../../bin/utils/path/repo-relative.js');
            return module.RelativePath;
        };

        it('keeps forward slashes', async () => {
            const WinRelativePath = await importWithWin32Path();
            expect(WinRelativePath.ROOT.join('actors/foo').toString()).toBe('actors/foo');
        });

        it('matches paths inside a scope', async () => {
            const WinRelativePath = await importWithWin32Path();
            const foo = WinRelativePath.ROOT.join('actors/foo');
            expect(WinRelativePath.ROOT.join('actors/foo/src/main.ts').isWithin(foo)).toBe(true);
        });
    });
});
