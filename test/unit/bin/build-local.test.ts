import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: editor-only TS6059 — test/tsconfig.json's rootDir doesn't span bin/, but the root
// tsconfig (used for the real build and for eslint's type-aware linting) has no such restriction.
import { ApifyBuilder } from '../../../bin/build.js';
import * as Utils from '../../../bin/utils.js';

vi.mock('node:child_process', () => ({
    spawnSync: vi.fn(),
}));

const APIFY_TOKEN_ENV_VAR = 'APIFY_TOKEN_TEST';

const mkTempDir = async (prefix: string) => fs.mkdtemp(path.join(os.tmpdir(), prefix));

describe('ApifyBuilder', () => {
    let builder: ApifyBuilder;
    const tempDirs: string[] = [];

    beforeEach(() => {
        process.env[APIFY_TOKEN_ENV_VAR] = 'dummy-token';
        builder = ApifyBuilder.fromActorName('test/actor');
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        delete process.env[APIFY_TOKEN_ENV_VAR];
        await Promise.all(tempDirs.splice(0).map(async (dir) => fs.rm(dir, { recursive: true, force: true })));
    });

    describe('collectNonIgnoredFiles', () => {
        it('drops secret-pattern files and gitignored files, keeps everything else', async () => {
            const rootDir = await mkTempDir('apify-test-tools-collect-');
            tempDirs.push(rootDir);

            await fs.writeFile(path.join(rootDir, 'main.js'), 'console.log(1)');
            await fs.writeFile(path.join(rootDir, '.env'), 'SECRET=1');
            await fs.mkdir(path.join(rootDir, 'sub'));
            await fs.writeFile(path.join(rootDir, 'sub', 'ignored.log'), 'log');

            // Only the gitignore side is mocked — isSecretFile runs for real, so this also
            // proves the secret-pattern backstop applies independently of .gitignore.
            vi.spyOn(Utils, 'getGitignoredPaths').mockImplementation(
                (relativePaths) => new Set(relativePaths.filter((p) => p.endsWith('.log'))),
            );

            const result = await builder.collectNonIgnoredFiles(rootDir, rootDir);

            expect(result).toStrictEqual([path.join(rootDir, 'main.js')]);
        });
    });

    describe('flattenMonorepoContext', () => {
        it('filters the .actor/ overlay through the same secret-pattern check as the rest of the context', async () => {
            const repoRoot = await mkTempDir('apify-test-tools-repo-');
            tempDirs.push(repoRoot);

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

            const flattenedDir = await builder.flattenMonorepoContext(
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

            await builder.rewriteActorJsonPaths(absActorDir, repoRoot, flattenedDir, actorJson);

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
