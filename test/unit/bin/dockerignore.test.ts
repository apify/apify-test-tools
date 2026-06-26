import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadDockerIgnore } from '../../../bin/dockerignore.js';

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

    it('handles directory patterns', () => {
        fsMock.readFileSync.mockReturnValue('dist/\n');
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

    it('reads .dockerignore from the dockerContextDir root', () => {
        fsMock.readFileSync.mockReturnValue('');
        loadDockerIgnore('actors/shopify');
        expect(fsMock.readFileSync).toHaveBeenCalledWith('actors/shopify/.dockerignore', 'utf-8');
    });

    it('reads .dockerignore from repo root when dockerContextDir is empty', () => {
        fsMock.readFileSync.mockReturnValue('');
        loadDockerIgnore('');
        expect(fsMock.readFileSync).toHaveBeenCalledWith('.dockerignore', 'utf-8');
    });

    it('handles comments and blank lines', () => {
        fsMock.readFileSync.mockReturnValue('# this is a comment\n\nnode_modules\n');
        const matcher = loadDockerIgnore('');
        expect(matcher('node_modules/foo.js')).toBe(true);
        expect(matcher('src/main.ts')).toBe(false);
    });
});
