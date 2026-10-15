import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type * as ApifyClientTypes from 'apify-client';
import { ActorSourceType, ApifyClient } from 'apify-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertRepoUrlMatchesDefaultVersion, deleteOldBuilds, resolveDefaultVersion, runBuilds } from '../src/build.js';
import type { ActorConfig } from '../src/types.js';
import { ExistingDir, ExistingFile, RelativeDir } from '../src/utils/path/repo-relative.js';

// Only the client is faked, so the tests exercise the real builder code against a stubbed API
vi.mock('apify-client', async (importOriginal) => {
    const actual = await importOriginal<typeof ApifyClientTypes>();
    return { ...actual, ApifyClient: vi.fn() };
});

const ACTOR = 'owner/actor';
const REPO_URL = 'git@github.com:owner/repo';

const makeActorInfo = (overrides: Partial<ApifyClientTypes.Actor> = {}): ApifyClientTypes.Actor =>
    ({
        defaultRunOptions: { build: 'latest' },
        taggedBuilds: { latest: { buildNumber: '0.1.5' } },
        versions: [
            { versionNumber: '0.1', sourceType: ActorSourceType.GitRepo, gitRepoUrl: `${REPO_URL}#master:actors/a` },
        ],
        ...overrides,
    }) as unknown as ApifyClientTypes.Actor;

describe('resolveDefaultVersion', () => {
    it('should resolve the version the default build tag points to', () => {
        const { defaultBuildTag, defaultBuildNumber, defaultVersionNumber, defaultVersion } = resolveDefaultVersion(
            ACTOR,
            makeActorInfo(),
        );
        expect(defaultBuildTag).toBe('latest');
        expect(defaultBuildNumber).toBe('0.1.5');
        expect(defaultVersionNumber).toBe('0.1');
        expect(defaultVersion?.versionNumber).toBe('0.1');
    });

    it('should explain the setup requirement when there is no default build', () => {
        expect(() => resolveDefaultVersion(ACTOR, makeActorInfo({ taggedBuilds: {} }))).toThrow(
            'every Actor needs at least one build under its default build tag',
        );
    });
});

describe('assertRepoUrlMatchesDefaultVersion', () => {
    const { defaultVersion } = resolveDefaultVersion(ACTOR, makeActorInfo());

    it('should pass when the repositories match in a different URL form', () => {
        expect(() =>
            assertRepoUrlMatchesDefaultVersion(ACTOR, defaultVersion, 'https://github.com/owner/repo.git'),
        ).not.toThrow();
    });

    it('should throw when the remote points to a different repository', () => {
        expect(() => assertRepoUrlMatchesDefaultVersion(ACTOR, defaultVersion, 'git@github.com:fork/repo')).toThrow(
            'Repository mismatch',
        );
    });

    it('should throw when the default version is not built from a Git repository', () => {
        const sourceFilesVersion: ApifyClientTypes.ActorVersion = {
            versionNumber: '0.1',
            sourceType: ActorSourceType.SourceFiles,
            sourceFiles: [],
        };
        expect(() => assertRepoUrlMatchesDefaultVersion(ACTOR, sourceFilesVersion, REPO_URL)).toThrow(
            'has source type "SOURCE_FILES"',
        );
    });

    it('should throw when the default version no longer exists', () => {
        expect(() => assertRepoUrlMatchesDefaultVersion(ACTOR, undefined, REPO_URL)).toThrow('no longer exists');
    });
});

describe('dry run', () => {
    const TOKEN_ENV_VAR = 'APIFY_TOKEN_OWNER';
    const originalCwd = process.cwd();
    let fixtureRoot: string;
    let actorConfig: ActorConfig;

    // ExistingDir checks the folder exists, so the config is built inside a throwaway repo root
    beforeAll(() => {
        fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apify-build-dry-run-'));
        process.chdir(fixtureRoot);
        fs.mkdirSync('actors/a/.actor', { recursive: true });
        fs.writeFileSync('actors/a/.actor/actor.json', '{}');
        actorConfig = {
            actorFullName: ACTOR,
            folder: new ExistingDir('actors/a'),
            tokenEnvVar: TOKEN_ENV_VAR,
            actorJson: {
                file: new ExistingFile('actors/a/.actor/actor.json'),
                dockerContextDir: new RelativeDir('actors/a'),
            },
            dockerContextDir: new RelativeDir('actors/a'),
            contextPaths: [new RelativeDir('actors/a')],
        };
    });

    afterAll(() => {
        process.chdir(originalCwd);
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });
    const deleteBuild = vi.fn();
    const startBuild = vi.fn();
    const createVersion = vi.fn();
    const buildClient = vi.fn(() => ({ delete: deleteBuild }));

    beforeEach(() => {
        vi.stubEnv(TOKEN_ENV_VAR, 'token');
        const fakeClient = {
            actor: () => ({
                get: async () => makeActorInfo(),
                // Old enough to be deleted, and not the default build 0.1.5
                builds: () => ({
                    list: async () => ({ items: [{ id: 'old-build', buildNumber: '0.0.1', startedAt: new Date(0) }] }),
                }),
                versions: () => ({ create: createVersion }),
                version: () => ({ update: createVersion }),
                build: startBuild,
            }),
            build: buildClient,
        };
        vi.mocked(ApifyClient).mockImplementation(function () {
            return fakeClient;
        } as never);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.clearAllMocks();
    });

    const runDryBuilds = async () =>
        runBuilds({
            actorConfigs: [actorConfig],
            repoUrl: REPO_URL,
            shouldVerifyRepoUrl: true,
            branch: 'feature',
            dryRun: true,
            useDockerCache: false,
        });

    it('should return a build plan without creating versions or builds', async () => {
        expect(await runDryBuilds()).toEqual({
            dryRun: true,
            builds: [
                {
                    actorFullName: ACTOR,
                    versionNumber: '0.99',
                    gitRepoUrl: `${REPO_URL}#feature:actors/a`,
                    useDockerCache: false,
                },
            ],
        });
        expect(createVersion).not.toHaveBeenCalled();
        expect(startBuild).not.toHaveBeenCalled();
    });

    it('should still require the Apify token', async () => {
        vi.stubEnv(TOKEN_ENV_VAR, '');
        await expect(runDryBuilds()).rejects.toThrow(`Env var ${TOKEN_ENV_VAR} is not set`);
    });

    it('should still check the repository URL', async () => {
        await expect(
            runBuilds({
                actorConfigs: [actorConfig],
                repoUrl: 'git@github.com:fork/repo',
                shouldVerifyRepoUrl: true,
                branch: 'feature',
                dryRun: true,
                useDockerCache: false,
            }),
        ).rejects.toThrow('Repository mismatch');
    });

    it('should not delete old builds', async () => {
        await deleteOldBuilds([actorConfig], { dryRun: true });
        expect(deleteBuild).not.toHaveBeenCalled();
    });

    it('should delete old builds outside of a dry run', async () => {
        await deleteOldBuilds([actorConfig], { dryRun: false });
        expect(buildClient).toHaveBeenCalledWith('old-build');
        expect(deleteBuild).toHaveBeenCalledTimes(1);
    });
});
