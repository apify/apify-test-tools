import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDockerIgnoreMatcher, loadDockerIgnore } from '../../../bin/dockerignore.js';

const { fsMock } = vi.hoisted(() => ({
    fsMock: {
        readFileSync: vi.fn(),
    },
}));

vi.mock('node:fs', () => ({ default: fsMock }));

afterEach(() => vi.restoreAllMocks());

describe('loadDockerIgnore', () => {
    it('returns no-op matcher when .dockerignore is absent', () => {
        fsMock.readFileSync.mockImplementation(() => {
            throw new Error('ENOENT');
        });
        const matcher = loadDockerIgnore('actors/my-actor');
        expect(matcher('actors/my-actor/src/main.ts')).toBe(false);
        expect(matcher('actors/my-actor/node_modules/foo.js')).toBe(false);
    });

    it('matches files listed in .dockerignore', () => {
        fsMock.readFileSync.mockReturnValue('node_modules\n*.log\n');
        const matcher = loadDockerIgnore('');
        expect(matcher('node_modules/foo/bar.js')).toBe(true);
        expect(matcher('debug.log')).toBe(true);
    });

    it('does not match files not in .dockerignore', () => {
        fsMock.readFileSync.mockReturnValue('node_modules\n');
        const matcher = loadDockerIgnore('');
        expect(matcher('src/main.ts')).toBe(false);
    });

    it.each(['dist', 'dist/'])('handles directory pattern "%s"', (pattern) => {
        fsMock.readFileSync.mockReturnValue(`${pattern}\n`);
        const matcher = loadDockerIgnore('');
        expect(matcher('dist/bundle.js')).toBe(true);
        expect(matcher('src/dist-utils.ts')).toBe(false);
    });

    it('handles negation patterns', () => {
        fsMock.readFileSync.mockReturnValue('*.log\n!important.log\n');
        const matcher = loadDockerIgnore('');
        expect(matcher('debug.log')).toBe(true);
        expect(matcher('important.log')).toBe(false);
    });

    it('strips dockerContextDir prefix before matching', () => {
        fsMock.readFileSync.mockReturnValue('node_modules\n');
        const matcher = loadDockerIgnore('actors/shopify');
        expect(matcher('actors/shopify/node_modules/foo.js')).toBe(true);
        expect(matcher('actors/shopify/src/main.ts')).toBe(false);
    });

    it('returns false for files outside dockerContextDir', () => {
        fsMock.readFileSync.mockReturnValue('*\n');
        const matcher = loadDockerIgnore('actors/shopify');
        expect(matcher('other-actor/src/main.ts')).toBe(false);
    });

    it('reads .dockerignore from the resolved, absolute dockerContextDir root', () => {
        fsMock.readFileSync.mockReturnValue('');
        loadDockerIgnore('actors/shopify');
        expect(fsMock.readFileSync).toHaveBeenCalledWith(
            path.join(path.resolve('actors/shopify'), '.dockerignore'),
            'utf-8',
        );
    });

    it('reads .dockerignore from the resolved repo root when dockerContextDir is empty', () => {
        fsMock.readFileSync.mockReturnValue('');
        loadDockerIgnore('');
        expect(fsMock.readFileSync).toHaveBeenCalledWith(path.join(path.resolve(''), '.dockerignore'), 'utf-8');
    });

    it('handles comments and blank lines', () => {
        fsMock.readFileSync.mockReturnValue('# this is a comment\n\nnode_modules\n');
        const matcher = loadDockerIgnore('');
        expect(matcher('node_modules/foo.js')).toBe(true);
        expect(matcher('src/main.ts')).toBe(false);
    });

    it('normalizes a leading "./" in patterns, which Docker treats as a no-op', () => {
        // The common real-world .dockerignore style: every pattern prefixed with "./",
        // including a negation re-including one of the otherwise-matched files.
        fsMock.readFileSync.mockReturnValue('./node_modules\n./*.log\n!./keep.log\n');
        const matcher = loadDockerIgnore('');
        expect(matcher('node_modules/foo.js')).toBe(true);
        expect(matcher('debug.log')).toBe(true);
        expect(matcher('keep.log')).toBe(false);
        expect(matcher('main.js')).toBe(false);
    });
});

describe('buildDockerIgnoreMatcher', () => {
    it('treats paths as already relative to absoluteRootDir when hoistFrom is left at its default', () => {
        fsMock.readFileSync.mockReturnValue('test/\n*.log\n');
        const matcher = buildDockerIgnoreMatcher('/repo/actors/shopify');
        expect(matcher('test/fixture.json')).toBe(true);
        expect(matcher('debug.log')).toBe(true);
        expect(matcher('main.js')).toBe(false);
    });

    it('reads .dockerignore from the given absoluteRootDir', () => {
        fsMock.readFileSync.mockReturnValue('');
        buildDockerIgnoreMatcher('/repo/actors/shopify');
        expect(fsMock.readFileSync).toHaveBeenCalledWith('/repo/actors/shopify/.dockerignore', 'utf-8');
    });

    it('returns no-op matcher when .dockerignore is absent', () => {
        fsMock.readFileSync.mockImplementation(() => {
            throw new Error('ENOENT');
        });
        const matcher = buildDockerIgnoreMatcher('/repo/actors/shopify');
        expect(matcher('main.js')).toBe(false);
    });
});
