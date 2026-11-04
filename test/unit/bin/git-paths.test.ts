import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getChangedFilesBetween, getChangelogAdditions } from '../../../bin/git.js';
import * as Utils from '../../../bin/utils.js';
import { getGitignoredPaths, listRepoFilePaths } from '../../../bin/utils.js';
import { RelativeFile } from '../../../bin/utils/path/repo-relative.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const filenames = ['space name.md', 'café.md', 'quote"name', 'tab\tname', 'line\nbreak', '[literal]*.md'];
let fixture: string;

beforeEach(async () => {
    // Use the existing repository for read-only Git queries, without creating Git history.
    fixture = await fs.mkdtemp(path.join(repoRoot, '.git-paths-test-'));
    await fs.mkdir(path.join(fixture, 'ignored'));
    await fs.writeFile(path.join(fixture, '.gitignore'), 'ignored/\n');
    await Promise.all(
        filenames.flatMap((name) => [
            fs.writeFile(path.join(fixture, name), ''),
            fs.writeFile(path.join(fixture, 'ignored', name), ''),
        ]),
    );
});

afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(fixture, { recursive: true, force: true });
});

describe('Git filename handling', () => {
    it('lists unusual filenames exactly, including ignored files', async () => {
        expect(new Set(await listRepoFilePaths(fixture, fixture))).toEqual(
            new Set(['.gitignore', ...filenames, ...filenames.map((name) => `ignored/${name}`)]),
        );
    });

    it('matches ignored paths exactly without quoting or splitting filenames', async () => {
        const ignored = filenames.map((name) => `ignored/${name}`);
        expect(await getGitignoredPaths([...filenames, ...ignored], fixture)).toEqual(new Set(ignored));
    });

    it('returns an empty set when none of the paths are ignored', async () => {
        expect(await getGitignoredPaths(filenames, fixture)).toEqual(new Set());
    });

    it('returns an empty set when given no paths', async () => {
        expect(await getGitignoredPaths([], fixture)).toEqual(new Set());
    });

    it.each(['ASCII.md', ...filenames])('extracts changelog additions from the exact changed path %j', async (file) => {
        await fs.writeFile(path.join(fixture, 'old.md'), '# Release\n');
        await fs.writeFile(path.join(fixture, file), '# Release\n- New feature\n');
        // Exercise real Git output without creating commits for the diff endpoints.
        vi.spyOn(Utils, 'runGitCommand').mockImplementation(async (args) => {
            const flags = args.includes('--name-only')
                ? args.filter((arg) => ['--name-only', '--no-renames', '-z'].includes(arg))
                : ['--no-renames'];
            const diff = spawnSync(
                'git',
                ['-c', 'core.quotePath=true', 'diff', '--no-index', ...flags, 'old.md', file],
                { cwd: fixture, encoding: 'utf8' },
            );
            expect(diff.status).toBe(1);
            return diff.stdout.trim();
        });

        const changedFiles = await getChangedFilesBetween('base', 'head');
        expect(changedFiles).toEqual([file]);
        await expect(getChangelogAdditions('base', 'head', changedFiles, [new RelativeFile(file)])).resolves.toBe(
            '- New feature',
        );
    });

    it('propagates Git errors outside a repository', async () => {
        const outsideRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'git-paths-not-repo-'));
        try {
            await expect(getGitignoredPaths(filenames, outsideRepo)).rejects.toThrow('not a git repository');
        } finally {
            await fs.rm(outsideRepo, { recursive: true, force: true });
        }
    });
});
