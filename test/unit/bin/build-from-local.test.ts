import type * as ChildProcessModule from 'node:child_process';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    collectNonIgnoredFiles,
    flattenMonorepoContext,
    rewriteActorJsonPaths,
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: editor-only TS6059 — test/tsconfig.json's rootDir doesn't span bin/, but the root
    // tsconfig (used for the real build and for eslint's type-aware linting) has no such restriction.
} from '../../../bin/build-from-local.js';
import * as Utils from '../../../bin/utils.js';

// Defaults to the real spawnSync so `git init`/`git ls-files` calls made by the code under test
// (and by test setup below) actually run — individual tests override this via mockReturnValue
// where they need to fake git's output, and vi.restoreAllMocks() reverts back to this passthrough.
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof ChildProcessModule>();
    return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const mkTempDir = async (prefix: string) => fs.mkdtemp(path.join(os.tmpdir(), prefix));

const initGitRepo = (dir: string) => {
    spawnSync('git', ['init', '-q'], { cwd: dir });
};

describe('build-from-local helpers', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all(tempDirs.splice(0).map(async (dir) => fs.rm(dir, { recursive: true, force: true })));
    });

    describe('collectNonIgnoredFiles', () => {
        it('drops secret-pattern files and gitignored files, keeps everything else', async () => {
            const rootDir = await mkTempDir('apify-test-tools-collect-');
            tempDirs.push(rootDir);
            initGitRepo(rootDir);

            await fs.writeFile(path.join(rootDir, 'main.js'), 'console.log(1)');
            await fs.writeFile(path.join(rootDir, '.env'), 'SECRET=1');
            await fs.mkdir(path.join(rootDir, 'sub'));
            await fs.writeFile(path.join(rootDir, 'sub', 'ignored.log'), 'log');

            // Only the gitignore side is mocked — isSecretFile runs for real, so this also
            // proves the secret-pattern backstop applies independently of .gitignore.
            vi.spyOn(Utils, 'getGitignoredPaths').mockImplementation(
                (relativePaths) => new Set(relativePaths.filter((p) => p.endsWith('.log'))),
            );

            const result = collectNonIgnoredFiles(rootDir, rootDir);

            expect(result).toStrictEqual([path.join(rootDir, 'main.js')]);
        });
    });

    describe('flattenMonorepoContext', () => {
        it('filters the .actor/ overlay through the same secret-pattern check as the rest of the context', async () => {
            const repoRoot = await mkTempDir('apify-test-tools-repo-');
            tempDirs.push(repoRoot);
            initGitRepo(repoRoot);

            const absActorDir = path.join(repoRoot, 'actors', 'owner_actor');
            await fs.mkdir(path.join(absActorDir, '.actor'), { recursive: true });
            await fs.writeFile(
                path.join(absActorDir, '.actor', 'actor.json'),
                JSON.stringify({ actorSpecification: 1, name: 'actor' }),
            );
            // A stray secret file inside .actor/ must never survive into the build.
            await fs.writeFile(path.join(absActorDir, '.actor', '.env'), 'SECRET=leaked');
            await fs.writeFile(path.join(absActorDir, '.actor', 'INPUT_SCHEMA.json'), '{}');

            const keptContextFile = path.join(repoRoot, 'package.json');
            await fs.writeFile(keptContextFile, '{}');

            // Nothing is gitignored here — isolates the assertion to the secret-pattern filter.
            vi.spyOn(Utils, 'getGitignoredPaths').mockReturnValue(new Set());

            const actorJson = JSON.parse(
                await fs.readFile(path.join(absActorDir, '.actor', 'actor.json'), 'utf8'),
            ) as Record<string, unknown>;

            const { tempDir: flattenedDir, filePaths } = await flattenMonorepoContext(
                'test/actor',
                absActorDir,
                repoRoot,
                actorJson,
                [keptContextFile],
                repoRoot,
            );
            tempDirs.push(flattenedDir);

            await expect(fs.access(path.join(flattenedDir, '.actor', '.env'))).rejects.toThrow();
            await expect(fs.access(path.join(flattenedDir, '.actor', 'INPUT_SCHEMA.json'))).resolves.toBeUndefined();
            await expect(fs.access(path.join(flattenedDir, '.actor', 'actor.json'))).resolves.toBeUndefined();
            await expect(fs.access(path.join(flattenedDir, 'package.json'))).resolves.toBeUndefined();

            // The returned filePaths must match what actually landed on disk — no .env, everything else present.
            expect(new Set(filePaths)).toStrictEqual(
                new Set([
                    path.join(flattenedDir, 'package.json'),
                    path.join(flattenedDir, '.actor', 'INPUT_SCHEMA.json'),
                    path.join(flattenedDir, '.actor', 'actor.json'),
                ]),
            );
        });

        it("keeps another actor's .actor/ directory intact at its original nested path", async () => {
            const repoRoot = await mkTempDir('apify-test-tools-repo-');
            tempDirs.push(repoRoot);
            initGitRepo(repoRoot);

            const absActorDir = path.join(repoRoot, 'actors', 'owner_actor');
            await fs.mkdir(path.join(absActorDir, '.actor'), { recursive: true });
            await fs.writeFile(
                path.join(absActorDir, '.actor', 'actor.json'),
                JSON.stringify({ actorSpecification: 1, name: 'actor' }),
            );

            const otherActorDir = path.join(repoRoot, 'actors', 'owner_other-actor');
            await fs.mkdir(path.join(otherActorDir, '.actor'), { recursive: true });
            const otherActorSchemaFile = path.join(otherActorDir, '.actor', 'input_schema.json');
            await fs.writeFile(otherActorSchemaFile, JSON.stringify({ schema: 'other' }));

            vi.spyOn(Utils, 'getGitignoredPaths').mockReturnValue(new Set());

            const actorJson = JSON.parse(
                await fs.readFile(path.join(absActorDir, '.actor', 'actor.json'), 'utf8'),
            ) as Record<string, unknown>;

            const { tempDir: flattenedDir, filePaths } = await flattenMonorepoContext(
                'test/actor',
                absActorDir,
                repoRoot,
                actorJson,
                [otherActorSchemaFile],
                repoRoot,
            );
            tempDirs.push(flattenedDir);

            const preservedPath = path.join(flattenedDir, 'actors', 'owner_other-actor', '.actor', 'input_schema.json');
            await expect(fs.access(preservedPath)).resolves.toBeUndefined();
            expect(filePaths).toContain(preservedPath);
        });
    });

    describe('rewriteActorJsonPaths', () => {
        it('rewrites path fields that escape .actor/ relative to the new flattened location', async () => {
            const repoRoot = await mkTempDir('apify-test-tools-rewrite-');
            tempDirs.push(repoRoot);
            const flattenedDir = await mkTempDir('apify-test-tools-flattened-');
            tempDirs.push(flattenedDir);

            const absActorDir = path.join(repoRoot, 'actors', 'owner_actor');
            await fs.mkdir(path.join(flattenedDir, '.actor'), { recursive: true });

            const actorJson = {
                actorSpecification: 1,
                name: 'my-actor',
                dockerfile: '../../../Dockerfile', // repo root, outside .actor/
                dockerContextDir: '../../..', // repo root itself
                changelog: './CHANGELOG.md', // stays inside .actor/
            };

            await rewriteActorJsonPaths(absActorDir, repoRoot, flattenedDir, actorJson);

            const rewritten = JSON.parse(
                await fs.readFile(path.join(flattenedDir, '.actor', 'actor.json'), 'utf8'),
            ) as Record<string, string>;

            expect(rewritten.dockerfile).toBe('../Dockerfile');
            expect(rewritten.dockerContextDir).toBe('..');
            expect(rewritten.changelog).toBe('./CHANGELOG.md');
        });
    });
});

describe('getDockerignoredPaths', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        vi.mocked(spawnSync).mockClear();
        await Promise.all(tempDirs.splice(0).map(async (dir) => fs.rm(dir, { recursive: true, force: true })));
    });

    it('returns an empty set without calling git when given no paths', () => {
        const result = Utils.getDockerignoredPaths('/does/not/matter', []);

        expect(result).toStrictEqual(new Set());
        expect(spawnSync).not.toHaveBeenCalled();
    });

    it('returns an empty set when rootDir has no .dockerignore', async () => {
        const rootDir = await mkTempDir('apify-test-tools-dockerignore-');
        tempDirs.push(rootDir);
        initGitRepo(rootDir);

        expect(Utils.getDockerignoredPaths(rootDir, ['main.js'])).toStrictEqual(new Set());
    });

    it('returns the paths that match .dockerignore patterns rooted at rootDir', async () => {
        const rootDir = await mkTempDir('apify-test-tools-dockerignore-');
        tempDirs.push(rootDir);
        initGitRepo(rootDir);

        await fs.writeFile(path.join(rootDir, '.dockerignore'), 'test/\n*.log\n');

        const result = Utils.getDockerignoredPaths(rootDir, ['main.js', 'test/fixture.json', 'debug.log']);

        expect(result).toStrictEqual(new Set(['test/fixture.json', 'debug.log']));
    });

    it('matches "./"-prefixed patterns, which Docker treats as a no-op but git treats as literal text', async () => {
        const rootDir = await mkTempDir('apify-test-tools-dockerignore-');
        tempDirs.push(rootDir);
        initGitRepo(rootDir);

        // The common real-world .dockerignore style: every pattern prefixed with "./",
        // including a negation re-including one of the otherwise-matched files.
        await fs.writeFile(path.join(rootDir, '.dockerignore'), './node_modules\n./*.log\n!./keep.log\n');

        const result = Utils.getDockerignoredPaths(rootDir, [
            'node_modules/foo.js',
            'debug.log',
            'keep.log',
            'main.js',
        ]);

        expect(result).toStrictEqual(new Set(['node_modules/foo.js', 'debug.log']));
    });

    it('matches already-tracked files too, since Docker excludes them regardless of git tracking', async () => {
        const rootDir = await mkTempDir('apify-test-tools-dockerignore-');
        tempDirs.push(rootDir);
        initGitRepo(rootDir);
        spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: rootDir });
        spawnSync('git', ['config', 'user.name', 'Test'], { cwd: rootDir });

        // Husky hooks are committed to the repo, so this path is tracked by git — by default
        // `git check-ignore` never reports a tracked file as ignored, which would otherwise mask
        // this exact pattern from matching, unlike a real Docker build which excludes it anyway.
        await fs.mkdir(path.join(rootDir, '.husky'));
        await fs.writeFile(path.join(rootDir, '.husky', 'pre-commit'), '#!/bin/sh\n');
        spawnSync('git', ['add', '.husky/pre-commit'], { cwd: rootDir });
        spawnSync('git', ['commit', '-q', '-m', 'add husky hook'], { cwd: rootDir });

        await fs.writeFile(path.join(rootDir, '.dockerignore'), './.husky\n');

        const result = Utils.getDockerignoredPaths(rootDir, ['.husky/pre-commit', 'main.js']);

        expect(result).toStrictEqual(new Set(['.husky/pre-commit']));
    });
});

describe('getGitignoredPaths', () => {
    beforeEach(() => {
        vi.mocked(spawnSync).mockReset();
    });

    it('returns an empty set without calling git when given no paths', () => {
        const result = Utils.getGitignoredPaths([]);

        expect(result).toStrictEqual(new Set());
        expect(spawnSync).not.toHaveBeenCalled();
    });

    it('returns the paths git reports as ignored, feeding all candidates via stdin', () => {
        vi.mocked(spawnSync).mockReturnValue({
            status: 0,
            stdout: 'node_modules/foo.js\n.env\n',
            stderr: '',
        } as unknown as ReturnType<typeof spawnSync>);

        const result = Utils.getGitignoredPaths(['node_modules/foo.js', 'bin/build.ts', '.env']);

        expect(result).toStrictEqual(new Set(['node_modules/foo.js', '.env']));
        expect(spawnSync).toHaveBeenCalledWith(
            'git',
            ['check-ignore', '--stdin'],
            expect.objectContaining({ input: 'node_modules/foo.js\nbin/build.ts\n.env' }),
        );
    });

    it('returns an empty set when git reports nothing is ignored (exit code 1)', () => {
        vi.mocked(spawnSync).mockReturnValue({
            status: 1,
            stdout: '',
            stderr: '',
        } as unknown as ReturnType<typeof spawnSync>);

        expect(Utils.getGitignoredPaths(['bin/build.ts'])).toStrictEqual(new Set());
    });

    it('throws on an unexpected git failure instead of silently including/excluding files', () => {
        vi.mocked(spawnSync).mockReturnValue({
            status: 128,
            stdout: '',
            stderr: 'fatal: not a git repository',
        } as unknown as ReturnType<typeof spawnSync>);

        expect(() => Utils.getGitignoredPaths(['bin/build.ts'])).toThrow('git check-ignore');
    });
});
