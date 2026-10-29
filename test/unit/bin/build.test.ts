import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type * as ApifyClientTypes from 'apify-client';
import { ActorSourceType, ApifyClient } from 'apify-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ApifyBuilder,
    assertEnvVarsMatchDefaultVersion,
    assertRepoUrlMatchesDefaultVersion,
    buildActors,
    deleteOldBuilds,
    resolveDefaultVersion,
    runBuilds,
} from '../../../bin/build.js';
import * as Git from '../../../bin/git.js';
import { logger } from '../../../bin/logger.js';
import type { ActorConfig } from '../../../bin/types.js';
import { ExistingDir, ExistingFile, RelativeDir } from '../../../bin/utils/path/repo-relative.js';

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

describe('runBuilds version number', () => {
    // Only the name and folder of the Actor matter here, the builder is stubbed
    const actorConfig = { actorFullName: ACTOR, folder: { isRoot: () => true } } as unknown as ActorConfig;
    // Restored after each test, so the stub never reaches the tests that run the real builder
    afterEach(() => {
        vi.mocked(ApifyBuilder.fromActorConfig).mockRestore();
    });

    const dryRunBuild = async (versionNumber: string, actorInfo = makeActorInfo()) => {
        vi.spyOn(ApifyBuilder, 'fromActorConfig').mockReturnValue({
            getActorInfo: async () => actorInfo,
        } as unknown as ApifyBuilder);
        const result = await runBuilds({
            actorConfigs: [actorConfig],
            versionNumber,
            repoUrl: REPO_URL,
            shouldVerifyRepoUrl: false,
            branch: 'master',
            dryRun: true,
        });
        if (Array.isArray(result)) throw new Error('A dry run must return a plan, not builds');
        return result.builds[0].versionNumber;
    };

    it('builds the version it is given', async () => {
        await expect(dryRunBuild('0.99')).resolves.toBe('0.99');
    });

    it("resolves default to the version the Actor's default build tag points to", async () => {
        await expect(dryRunBuild('default')).resolves.toBe('0.1');
    });

    it('warns when the default version does not give its builds the default build tag', async () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        await dryRunBuild('default');
        // The fixture's version 0.1 has no build tag of its own
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('users keep running the previous build'));
    });

    it('does not warn when the default version gives its builds the default build tag', async () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const versions = [{ versionNumber: '0.1', buildTag: 'latest', sourceType: ActorSourceType.GitRepo }];
        await dryRunBuild('default', makeActorInfo({ versions } as Partial<ApifyClientTypes.Actor>));
        expect(warnSpy).not.toHaveBeenCalled();
    });
});

describe('buildActors', () => {
    it('builds nothing and needs no branch or repository when there are no Actors', async () => {
        const branchSpy = vi.spyOn(Git, 'getCurrentBranch');
        const repoSpy = vi.spyOn(Git, 'resolveRepoUrl');

        await expect(buildActors({ actorConfigs: [], versionNumber: '0.99', dryRun: false })).resolves.toStrictEqual(
            [],
        );
        // A dry run keeps the dry-run shape even with nothing to build
        await expect(buildActors({ actorConfigs: [], versionNumber: '0.99', dryRun: true })).resolves.toStrictEqual({
            dryRun: true,
            builds: [],
        });
        expect(branchSpy).not.toHaveBeenCalled();
        expect(repoSpy).not.toHaveBeenCalled();
    });
});

describe('assertEnvVarsMatchDefaultVersion', () => {
    const makeVersion = (versionNumber: string, names: string[]): ApifyClientTypes.ActorVersion => ({
        versionNumber,
        sourceType: ActorSourceType.GitRepo,
        gitRepoUrl: REPO_URL,
        envVars: names.map((name) => ({ name, isSecret: true })),
    });
    const makeActorInfoWithEnvVars = (defaultNames: string[], testNames?: string[]) =>
        makeActorInfo({
            versions: [makeVersion('0.1', defaultNames), ...(testNames ? [makeVersion('0.99', testNames)] : [])],
        });
    const check = (actorInfo: ApifyClientTypes.Actor, versionNumber = '0.99') =>
        assertEnvVarsMatchDefaultVersion(
            ACTOR,
            actorInfo,
            resolveDefaultVersion(ACTOR, actorInfo).defaultVersion,
            versionNumber,
        );

    it('should pass when the names match in any order, whatever the values', () => {
        expect(() => check(makeActorInfoWithEnvVars(['A', 'B'], ['B', 'A']))).not.toThrow();
    });

    it('should pass for the default version itself', () => {
        expect(() => check(makeActorInfoWithEnvVars(['A']), '0.1')).not.toThrow();
    });

    it('should pass when neither version has env vars', () => {
        expect(() => check(makeActorInfo())).not.toThrow();
    });

    it('should list the missing and extra names', () => {
        expect(() => check(makeActorInfoWithEnvVars(['A', 'B'], ['B', 'C']))).toThrow(
            'Env vars of version 0.99 are out of sync with default version 0.1 (missing A; extra C)',
        );
    });

    it('should ask to create the version when it does not exist yet', () => {
        expect(() => check(makeActorInfoWithEnvVars(['A']))).toThrow("Version 0.99 doesn't exist yet");
    });

    it('should throw when the default version no longer exists', () => {
        expect(() => assertEnvVarsMatchDefaultVersion(ACTOR, makeActorInfo(), undefined, '0.99')).toThrow(
            'no longer exists',
        );
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

    let actorInfo: ApifyClientTypes.Actor;

    beforeEach(() => {
        vi.stubEnv(TOKEN_ENV_VAR, 'token');
        actorInfo = makeActorInfo();
        const fakeClient = {
            actor: () => ({
                get: async () => actorInfo,
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

    const runDryBuilds = async (requireEnvVarsInSync = false) =>
        runBuilds({
            actorConfigs: [actorConfig],
            repoUrl: REPO_URL,
            shouldVerifyRepoUrl: true,
            branch: 'feature',
            dryRun: true,
            versionNumber: '0.99',
            requireEnvVarsInSync,
        });

    it('should return a build plan without creating versions or builds', async () => {
        expect(await runDryBuilds()).toEqual({
            dryRun: true,
            builds: [
                {
                    actorFullName: ACTOR,
                    versionNumber: '0.99',
                    gitRepoUrl: `${REPO_URL}#feature:actors/a`,
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
                versionNumber: '0.99',
            }),
        ).rejects.toThrow('Repository mismatch');
    });

    describe('with the default version holding an env var the test version lacks', () => {
        beforeEach(() => {
            actorInfo = makeActorInfo({
                versions: [
                    {
                        versionNumber: '0.1',
                        sourceType: ActorSourceType.GitRepo,
                        gitRepoUrl: REPO_URL,
                        envVars: [{ name: 'API_KEY', isSecret: true }],
                    },
                ],
            });
        });

        it('should still check the env vars when asked to', async () => {
            await expect(runDryBuilds(true)).rejects.toThrow('missing API_KEY');
        });

        it('should not check the env vars unless asked to', async () => {
            await expect(runDryBuilds()).resolves.toMatchObject({ dryRun: true });
        });
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
