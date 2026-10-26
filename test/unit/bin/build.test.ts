import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type * as ApifyClientTypes from 'apify-client';
import { ActorSourceType, ApifyClient } from 'apify-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ApifyBuilder,
    assertRepoUrlMatchesDefaultVersion,
    buildActors,
    type BuildPlan,
    deleteOldBuilds,
    executeBuildPlans,
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
            versionNumber: '0.99',
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

describe('executeBuildPlans', () => {
    const makePlan = (
        actorFullName: string,
        builder: unknown,
        upload = vi.fn(),
    ): BuildPlan<{ actorFullName: string }> => ({
        builder: builder as ApifyBuilder,
        actorInfo: makeActorInfo(),
        versionNumber: '0.99',
        useCache: true,
        summary: { actorFullName },
        description: actorFullName,
        toActorVersion: async () => {
            upload();
            return { versionNumber: '0.99', sourceType: ActorSourceType.GitRepo, gitRepoUrl: REPO_URL };
        },
    });
    const makeBuilder = (actorFullName: string) => ({
        createVersionAndBuild: vi.fn(async () => ({
            buildId: `build-${actorFullName}`,
            actorRawId: 'id',
            buildNumber: '0.99.1',
            actorFullName,
        })),
        waitForBuildToFinish: vi.fn(async () => ({})),
    });

    it('starts every build, waits for all of them and returns them sorted by Actor', async () => {
        const [b, a] = [makeBuilder('owner/b'), makeBuilder('owner/a')];
        const builds = await executeBuildPlans([makePlan('owner/b', b), makePlan('owner/a', a)], {
            label: 'BUILDS',
            dryRun: false,
        });
        expect(builds).toEqual([
            expect.objectContaining({ actorFullName: 'owner/a' }),
            expect.objectContaining({ actorFullName: 'owner/b' }),
        ]);
        expect(a.waitForBuildToFinish).toHaveBeenCalledWith('build-owner/a');
        expect(b.waitForBuildToFinish).toHaveBeenCalledWith('build-owner/b');
    });

    it('fails when a build fails and does not summarize', async () => {
        const builder = makeBuilder('owner/a');
        builder.waitForBuildToFinish.mockRejectedValue(new Error('Build failed'));
        await expect(
            executeBuildPlans([makePlan('owner/a', builder)], { label: 'BUILDS', dryRun: false }),
        ).rejects.toThrow('Build failed');
    });

    it('only reports the summaries in a dry run, without touching the platform', async () => {
        const builder = makeBuilder('owner/a');
        const upload = vi.fn();
        const result = await executeBuildPlans([makePlan('owner/a', builder, upload)], {
            label: 'BUILDS',
            dryRun: true,
        });
        expect(result).toStrictEqual({ dryRun: true, builds: [{ actorFullName: 'owner/a' }] });
        expect(upload).not.toHaveBeenCalled();
        expect(builder.createVersionAndBuild).not.toHaveBeenCalled();
    });

    it('builds nothing for no plans, in the shape of the mode', async () => {
        await expect(executeBuildPlans([], { label: 'BUILDS', dryRun: false })).resolves.toStrictEqual([]);
        await expect(executeBuildPlans([], { label: 'BUILDS', dryRun: true })).resolves.toStrictEqual({
            dryRun: true,
            builds: [],
        });
    });
});
