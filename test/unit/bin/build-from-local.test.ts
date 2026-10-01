import type * as ChildProcessModule from 'node:child_process';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    collectNonIgnoredFiles,
    collectSourceFiles,
    flattenMonorepoContext,
    rewriteActorJsonPaths,
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: editor-only TS6059 — test/tsconfig.json's rootDir doesn't span bin/, but the root
    // tsconfig (used for the real build and for eslint's type-aware linting) has no such restriction.
} from '../../../bin/build-from-local.js';
import type { ActorConfig } from '../../../bin/types.js';
import * as Utils from '../../../bin/utils.js';
import { ExistingDir, ExistingFile, RelativeDir } from '../../../bin/utils/path/repo-relative.js';

// Keep the real spawnSync as the default; individual tests mock Git's read-only output.
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof ChildProcessModule>();
    return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const mkTempDir = async (prefix: string) => fs.mkdtemp(path.join(os.tmpdir(), prefix));

const gitResult = (status: number, stdout: string, stderr = ''): ReturnType<typeof spawnSync> => {
    const stdoutBuffer = Buffer.from(stdout);
    const stderrBuffer = Buffer.from(stderr);
    return {
        pid: 0,
        output: [null, stdoutBuffer, stderrBuffer],
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        status,
        signal: null,
    };
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

            await fs.writeFile(path.join(rootDir, 'main.js'), 'console.log(1)');
            await fs.writeFile(path.join(rootDir, '.env'), 'SECRET=1');
            await fs.writeFile(path.join(rootDir, 'docker-ignored.txt'), 'ignored');
            await fs.writeFile(path.join(rootDir, '.dockerignore'), 'docker-ignored.txt\n');
            await fs.mkdir(path.join(rootDir, 'sub'));
            await fs.writeFile(path.join(rootDir, 'sub', 'ignored.log'), 'log');

            vi.spyOn(Utils, 'listRepoFilePaths').mockReturnValue([
                'main.js',
                '.env',
                'docker-ignored.txt',
                'sub/ignored.log',
            ]);
            vi.spyOn(Utils, 'getGitignoredPaths').mockImplementation(
                (relativePaths) => new Set(relativePaths.filter((p) => p.endsWith('.log'))),
            );

            const originalCwd = process.cwd();
            process.chdir(rootDir);
            try {
                expect(collectNonIgnoredFiles(RelativeDir.ROOT, rootDir)).toStrictEqual([
                    path.join(rootDir, 'main.js'),
                ]);
            } finally {
                process.chdir(originalCwd);
            }
        });

        it('matches .dockerignore relative to a nested Docker context', async () => {
            const rootDir = await mkTempDir('apify-test-tools-nested-context-');
            tempDirs.push(rootDir);
            await fs.mkdir(path.join(rootDir, 'actors', 'shopify'), { recursive: true });
            await fs.writeFile(path.join(rootDir, 'actors', 'shopify', '.dockerignore'), 'dist/\n');

            vi.spyOn(Utils, 'listRepoFilePaths').mockReturnValue([
                'actors/shopify/dist/bundle.js',
                'actors/shopify/src/main.ts',
            ]);
            vi.spyOn(Utils, 'getGitignoredPaths').mockReturnValue(new Set());

            const originalCwd = process.cwd();
            process.chdir(rootDir);
            try {
                expect(collectNonIgnoredFiles(new RelativeDir('actors/shopify'), rootDir)).toStrictEqual([
                    path.join(rootDir, 'actors', 'shopify', 'src', 'main.ts'),
                ]);
            } finally {
                process.chdir(originalCwd);
            }
        });
    });

    describe('flattenMonorepoContext', () => {
        it("overlays the actor's own .actor/ files at the flattened root", async () => {
            // Simulates flattening from a monorepo with an actors/<name>/.actor structure.
            const repoRoot = await mkTempDir('apify-test-tools-repo-');
            tempDirs.push(repoRoot);

            const absActorDir = path.join(repoRoot, 'actors', 'owner_actor');
            const actorJsonPath = path.join(absActorDir, '.actor', 'actor.json');
            const inputSchemaPath = path.join(absActorDir, '.actor', 'INPUT_SCHEMA.json');
            const mainSrcPath = path.join(absActorDir, 'src', 'main.ts');
            const packageJsonPath = path.join(repoRoot, 'package.json');

            await fs.mkdir(path.join(absActorDir, '.actor'), { recursive: true });
            await fs.mkdir(path.join(absActorDir, 'src'), { recursive: true });
            await fs.writeFile(actorJsonPath, JSON.stringify({ actorSpecification: 1, name: 'actor' }));
            await fs.writeFile(inputSchemaPath, '{}');
            await fs.writeFile(mainSrcPath, 'console.log(1)');
            await fs.writeFile(packageJsonPath, '{}');

            const keptContextFiles = [packageJsonPath, mainSrcPath, actorJsonPath, inputSchemaPath];

            const actorJson = JSON.parse(await fs.readFile(actorJsonPath, 'utf8')) as Record<string, unknown>;

            const { tempDir: flattenedDir, filePaths } = await flattenMonorepoContext(
                'test/actor',
                absActorDir,
                repoRoot,
                actorJson,
                keptContextFiles,
            );
            tempDirs.push(flattenedDir);

            const flattenedMainSrcPath = path.join(flattenedDir, 'actors', 'owner_actor', 'src', 'main.ts');
            await expect(fs.access(path.join(flattenedDir, '.actor', 'actor.json'))).resolves.toBeUndefined();
            await expect(fs.access(path.join(flattenedDir, '.actor', 'INPUT_SCHEMA.json'))).resolves.toBeUndefined();
            await expect(fs.access(path.join(flattenedDir, 'package.json'))).resolves.toBeUndefined();
            await expect(fs.access(flattenedMainSrcPath)).resolves.toBeUndefined();
            expect(filePaths).toContain(path.join(flattenedDir, '.actor', 'actor.json'));
            expect(filePaths).toContain(path.join(flattenedDir, '.actor', 'INPUT_SCHEMA.json'));
            expect(filePaths).toContain(flattenedMainSrcPath);
        });

        it("keeps another actor's .actor/ directory intact at its original nested path", async () => {
            // Simulates flattening from a monorepo with an actors/<name>/.actor structure — two
            // sibling actors share the same context, but only one is being flattened here.
            const repoRoot = await mkTempDir('apify-test-tools-repo-');
            tempDirs.push(repoRoot);

            const absActorDir = path.join(repoRoot, 'actors', 'owner_actor');
            const actorJsonPath = path.join(absActorDir, '.actor', 'actor.json');
            const otherActorDir = path.join(repoRoot, 'actors', 'owner_other-actor');
            const otherActorSchemaFile = path.join(otherActorDir, '.actor', 'input_schema.json');

            await fs.mkdir(path.join(absActorDir, '.actor'), { recursive: true });
            await fs.writeFile(actorJsonPath, JSON.stringify({ actorSpecification: 1, name: 'actor' }));
            await fs.mkdir(path.join(otherActorDir, '.actor'), { recursive: true });
            await fs.writeFile(otherActorSchemaFile, JSON.stringify({ schema: 'other' }));

            // Stands in for collectNonIgnoredFiles's already-filtered output: the current actor's own
            // actor.json (always kept by collectNonIgnoredFiles's .actor/ bypass in the real flow —
            // see the collectSourceFiles test below) plus the other actor's file.
            const keptContextFiles = [actorJsonPath, otherActorSchemaFile];

            const actorJson = JSON.parse(await fs.readFile(actorJsonPath, 'utf8')) as Record<string, unknown>;

            const { tempDir: flattenedDir, filePaths } = await flattenMonorepoContext(
                'test/actor',
                absActorDir,
                repoRoot,
                actorJson,
                keptContextFiles,
            );
            tempDirs.push(flattenedDir);

            const preservedPath = path.join(flattenedDir, 'actors', 'owner_other-actor', '.actor', 'input_schema.json');
            await expect(fs.access(preservedPath)).resolves.toBeUndefined();
            expect(filePaths).toContain(preservedPath);
        });
    });

    describe('collectSourceFiles', () => {
        it("always collects the actor's own .actor/actor.json for a monorepo actor, since flattenMonorepoContext depends on it", async () => {
            const repoRoot = await mkTempDir('apify-test-tools-collect-source-');
            tempDirs.push(repoRoot);

            const originalCwd = process.cwd();
            // We simulate the working directory being the repo root, since collectSourceFiles uses relative paths to the repo root.
            Utils.setCwd({ workspace: repoRoot });
            try {
                const cwd = process.cwd();
                const actorDir = path.join(cwd, 'actors', 'owner_actor');
                await fs.mkdir(path.join(actorDir, '.actor'), { recursive: true });
                await fs.writeFile(
                    path.join(actorDir, '.actor', 'actor.json'),
                    JSON.stringify({ actorSpecification: 1, name: 'actor', dockerContextDir: '../../..' }),
                );
                await fs.writeFile(path.join(cwd, 'package.json'), '{}');

                vi.spyOn(Utils, 'listRepoFilePaths').mockReturnValue([
                    'actors/owner_actor/.actor/actor.json',
                    'package.json',
                ]);
                vi.spyOn(Utils, 'getGitignoredPaths').mockReturnValue(new Set());
                const actorConfig: ActorConfig = {
                    actorFullName: 'owner/actor',
                    folder: new ExistingDir('actors/owner_actor'),
                    tokenEnvVar: 'APIFY_TOKEN',
                    actorJson: {
                        file: new ExistingFile('actors/owner_actor/.actor/actor.json'),
                        dockerContextDir: RelativeDir.ROOT,
                    },
                    dockerContextDir: RelativeDir.ROOT,
                    contextPaths: [RelativeDir.ROOT],
                };
                const sourceFiles = await collectSourceFiles(actorConfig);
                expect(sourceFiles.map((file) => file.name)).toContain('.actor/actor.json');
            } finally {
                process.chdir(originalCwd);
            }
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
        vi.mocked(spawnSync).mockReturnValue(gitResult(0, 'node_modules/foo.js\n.env\n'));

        const result = Utils.getGitignoredPaths(['node_modules/foo.js', 'bin/build.ts', '.env']);

        expect(result).toStrictEqual(new Set(['node_modules/foo.js', '.env']));
        expect(spawnSync).toHaveBeenCalledWith(
            'git',
            ['check-ignore', '--stdin'],
            expect.objectContaining({ input: 'node_modules/foo.js\nbin/build.ts\n.env' }),
        );
    });

    it('returns an empty set when git reports nothing is ignored (exit code 1)', () => {
        vi.mocked(spawnSync).mockReturnValue(gitResult(1, ''));

        expect(Utils.getGitignoredPaths(['bin/build.ts'])).toStrictEqual(new Set());
    });

    it('throws on an unexpected git failure instead of silently including/excluding files', () => {
        vi.mocked(spawnSync).mockReturnValue(gitResult(128, '', 'fatal: not a git repository'));

        expect(() => Utils.getGitignoredPaths(['bin/build.ts'])).toThrow('git check-ignore');
    });
});
