import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RelativeDir, type RelativeFile } from '../../../../../bin/utils/path/repo-relative.js';

// Paths from the config file and from git all enter through the root.
const { ROOT } = RelativeDir;
const dir = (raw: string): RelativeDir => ROOT.joinDir(raw);
const file = (raw: string): RelativeFile => ROOT.joinFile(raw);

describe('RelativeDir', () => {
    describe('ROOT', () => {
        it('is a RelativeDir spelled "."', () => {
            expect(ROOT).toBeInstanceOf(RelativeDir);
            expect(ROOT.toString()).toBe('.');
        });

        it.each(['', '.', './', './/', 'a/..'])('is what %j parses to', (raw) => {
            expect(dir(raw).isEqualTo(ROOT)).toBe(true);
            expect(dir(raw).toString()).toBe('.');
        });
    });

    describe('parsing (ROOT.joinDir)', () => {
        it.each(['actors/foo', './actors/foo', 'actors/foo/', 'actors//foo', './actors/./foo//', 'actors/bar/../foo'])(
            'normalizes %j to actors/foo',
            (raw) => {
                expect(dir(raw).toString()).toBe('actors/foo');
            },
        );

        it.each(['..', '../x', 'actors/../../x', './..'])('rejects %j because it escapes the repo root', (raw) => {
            expect(() => dir(raw)).toThrow('escapes the repo root');
        });

        it('rejects absolute paths', () => {
            expect(() => file('/etc/passwd')).toThrow('got absolute path "/etc/passwd"');
        });

        it('rejects absolute paths even when they point inside the working directory', () => {
            expect(() => dir(path.join(process.cwd(), 'actors/foo'))).toThrow('got absolute path');
        });

        it('reports the path as written, not its normalized form', () => {
            expect(() => dir('a/../../x')).toThrow();
        });

        it('keeps a directory named "..foo", which does not escape the repo root', () => {
            expect(dir('..foo/bar').toString()).toBe('..foo/bar');
        });

        it('keeps case, since git paths are case-sensitive', () => {
            expect(dir('Actors/Foo').isEqualTo(dir('actors/foo'))).toBe(false);
        });
    });

    describe('joinDir / joinFile', () => {
        const actorDir = dir('actors/foo');
        const actorDotDir = dir('actors/foo/.actor');

        it('resolves relative to the path it is called on', () => {
            expect(actorDir.joinDir('src').toString()).toBe('actors/foo/src');
            expect(actorDir.joinFile('src/main.ts').toString()).toBe('actors/foo/src/main.ts');
        });

        it('resolves a dockerContextDir the way actor.json means it', () => {
            expect(actorDotDir.joinDir('..').toString()).toBe('actors/foo');
            expect(actorDotDir.joinDir('../..').toString()).toBe('actors');
            expect(actorDotDir.joinDir('../../..').isEqualTo(ROOT)).toBe(true);
            expect(actorDotDir.joinFile('./Dockerfile').toString()).toBe('actors/foo/.actor/Dockerfile');
        });

        it('can climb out of the path it is called on, as long as it stays within the repo root', () => {
            expect(actorDir.joinDir('../bar').toString()).toBe('actors/bar');
        });

        it('rejects results that escape the repo root', () => {
            expect(() => actorDotDir.joinDir('../../../..')).toThrow('escapes the repo root');
        });

        it('does not depend on the process working directory', () => {
            const originalCwd = process.cwd();
            try {
                process.chdir(path.join(originalCwd, 'bin'));
                expect(dir('actors/foo').toString()).toBe('actors/foo');
                expect(actorDir.joinDir('src').toString()).toBe('actors/foo/src');
            } finally {
                process.chdir(originalCwd);
            }
        });
    });

    describe('isEqualTo', () => {
        it('matches different spellings of the same path', () => {
            expect(dir('./actors/foo/').isEqualTo(dir('actors/foo'))).toBe(true);
        });

        it('does not match different paths', () => {
            expect(dir('actors/foo').isEqualTo(dir('actors/foobar'))).toBe(false);
        });
    });

    describe('isStrictAncestorOf', () => {
        const foo = dir('actors/foo');

        it('is true for paths inside it', () => {
            expect(foo.isStrictAncestorOf(file('actors/foo/src/main.ts'))).toBe(true);
        });

        it('is false for itself', () => {
            expect(foo.isStrictAncestorOf(foo)).toBe(false);
        });

        it('is false for a sibling that shares a name prefix', () => {
            expect(foo.isStrictAncestorOf(dir('actors/foobar'))).toBe(false);
        });

        it('makes the root an ancestor of every other path', () => {
            expect(ROOT.isStrictAncestorOf(foo)).toBe(true);
            expect(ROOT.isStrictAncestorOf(file('README.md'))).toBe(true);
            expect(ROOT.isStrictAncestorOf(ROOT)).toBe(false);
        });
    });

    describe('contains', () => {
        const foo = dir('actors/foo');

        it('matches itself and paths inside it', () => {
            expect(foo.contains(foo)).toBe(true);
            expect(foo.contains(file('actors/foo/src/main.ts'))).toBe(true);
        });

        it('does not match a sibling that shares a name prefix', () => {
            expect(foo.contains(file('actors/foobar/main.ts'))).toBe(false);
        });

        it('makes the root contain every path', () => {
            expect(ROOT.contains(foo)).toBe(true);
            expect(ROOT.contains(file('README.md'))).toBe(true);
            expect(ROOT.contains(ROOT)).toBe(true);
        });

        it('does not make a subfolder contain the root', () => {
            expect(foo.contains(ROOT)).toBe(false);
        });
    });

    describe('string output', () => {
        it('renders as the path in templates', () => {
            expect(`${dir('actors/foo')}/x`).toBe('actors/foo/x');
        });

        it('renders as a plain string in JSON', () => {
            expect(JSON.stringify({ folder: dir('actors/foo'), root: ROOT })).toBe(
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

        const importWithWin32Path = async (): Promise<typeof RelativeDir> => {
            vi.resetModules();
            vi.doMock('node:path', () => ({ default: path.win32, ...path.win32 }));
            const module = await import('../../../../../bin/utils/path/repo-relative.js');
            return module.RelativeDir;
        };

        it('keeps forward slashes', async () => {
            const WinRelativeDir = await importWithWin32Path();
            expect(WinRelativeDir.ROOT.joinDir('actors/foo').toString()).toBe('actors/foo');
        });

        it('matches paths inside a scope', async () => {
            const WinRelativeDir = await importWithWin32Path();
            const foo = WinRelativeDir.ROOT.joinDir('actors/foo');
            expect(foo.contains(WinRelativeDir.ROOT.joinFile('actors/foo/src/main.ts'))).toBe(true);
        });
    });
});
