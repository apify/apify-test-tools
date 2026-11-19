import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type * as ApifyClientTypes from 'apify-client';
import { ActorSourceType, ApifyClient } from 'apify-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ApifyBuilder,
    assertBranchAtCommit,
    assertEnvVarsMatchDefaultVersion,
    assertRepoUrlMatchesDefaultVersion,
    assertVersionBuildsFromBranch,
    assertVersionKeepsDefaultBuildTag,
    buildActors,
    buildOrReuseActors,
    deleteOldBuilds,
    parseVersionGitRepoUrl,
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

// A version that builds `ref` of REPO_URL, from the repository root unless a folder is given
const gitVersion = (
    versionNumber: string,
    ref: string,
    folder?: string,
    extra: Pick<ApifyClientTypes.ActorVersionGitRepo, 'buildTag' | 'envVars'> = {},
): ApifyClientTypes.ActorVersion => ({
    versionNumber,
    sourceType: ActorSourceType.GitRepo,
    gitRepoUrl: `${REPO_URL}#${ref}${folder ? `:${folder}` : ''}`,
    ...extra,
});

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
    const actorConfig = { actorFullName: ACTOR, folder: RelativeDir.ROOT } as unknown as ActorConfig;
    const versions = [gitVersion('0.1', 'master'), gitVersion('0.99', 'master')];
    // Restored after each test, so the stub never reaches the tests that run the real builder
    afterEach(() => {
        vi.mocked(ApifyBuilder.fromActorConfig).mockRestore();
    });

    const dryRunBuild = async (versionNumber: string, actorInfo = makeActorInfo({ versions })) => {
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
        const tagged = [gitVersion('0.1', 'master', undefined, { buildTag: 'latest' })];
        await dryRunBuild('default', makeActorInfo({ versions: tagged }));
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
            testTokenEnvVar: TOKEN_ENV_VAR,
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
        actorInfo = makeActorInfo({
            versions: [gitVersion('0.1', 'master', 'actors/a'), gitVersion('0.99', 'feature', 'actors/a')],
        });
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

    it('should return a build plan without changing versions or starting builds', async () => {
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
                    gitVersion('0.1', 'master', 'actors/a', { envVars: [{ name: 'API_KEY', isSecret: true }] }),
                    gitVersion('0.99', 'feature', 'actors/a'),
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

describe('buildOrReuseActors', () => {
    const TOKEN_ENV_VAR = 'APIFY_TOKEN_REUSE';
    const config = (actorFullName: string) =>
        ({ actorFullName, tokenEnvVar: TOKEN_ENV_VAR, folder: RelativeDir.ROOT }) as unknown as ActorConfig;
    const stored = { buildId: 'b1', actorRawId: 'raw-a', buildNumber: '0.99.4' };
    let builds: Record<string, unknown>;

    beforeEach(() => {
        vi.stubEnv(TOKEN_ENV_VAR, 'token');
        builds = { b1: { status: 'SUCCEEDED', actId: 'raw-a', buildNumber: '0.99.4' } };
        vi.mocked(ApifyClient).mockImplementation(function () {
            return {
                actor: () => ({
                    get: async () =>
                        makeActorInfo({ versions: [gitVersion('0.1', 'master'), gitVersion('0.99', 'feature')] }),
                }),
                build: (id: string) => ({ get: async () => builds[id] }),
            };
        } as never);
        vi.spyOn(Git, 'getCurrentBranch').mockResolvedValue('feature');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    const run = async (targets: Parameters<typeof buildOrReuseActors>[0]['targets']) =>
        buildOrReuseActors({
            targets,
            // Unique, like the configs build reads by name
            actorConfigs: [...new Set(targets.map(({ actorFullName }) => actorFullName))].map(config),
            versionNumber: '0.99',
            repoUrl: REPO_URL,
            dryRun: false,
        });
    // A dry run, so a build the reuse falls back to is planned rather than started
    const planned = async (targets: Parameters<typeof buildOrReuseActors>[0]['targets']) => {
        const result = await buildOrReuseActors({
            targets,
            actorConfigs: [...new Set(targets.map(({ actorFullName }) => actorFullName))].map(config),
            versionNumber: '0.99',
            repoUrl: REPO_URL,
            dryRun: true,
        });
        if (Array.isArray(result)) throw new Error('A dry run must return a plan');
        return result.builds.map(({ actorFullName }) => actorFullName);
    };

    it('passes the default build through, which test runs on the default build', async () => {
        await expect(run([{ actorFullName: 'owner/a', build: 'default' }])).resolves.toStrictEqual([
            { actorFullName: 'owner/a' },
        ]);
    });

    it('passes a stored build through while it exists and succeeded', async () => {
        await expect(run([{ actorFullName: 'owner/a', build: stored }])).resolves.toStrictEqual([
            { actorFullName: 'owner/a', ...stored },
        ]);
    });

    it.each([
        ['no longer exists', undefined],
        ['failed', { status: 'FAILED', actId: 'raw-a', buildNumber: '0.99.4' }],
        ['belongs to another Actor', { status: 'SUCCEEDED', actId: 'raw-b', buildNumber: '0.99.4' }],
    ])('builds again when the stored build %s', async (_, found) => {
        builds.b1 = found;
        await expect(planned([{ actorFullName: 'owner/a', build: stored }])).resolves.toStrictEqual(['owner/a']);
    });

    it('builds an Actor listed with two different builds', async () => {
        await expect(
            planned([
                { actorFullName: 'owner/a', build: 'default' },
                { actorFullName: 'owner/a', build: stored },
            ]),
        ).resolves.toStrictEqual(['owner/a']);
    });

    it('reuses the build of an Actor listed twice with the same build', async () => {
        await expect(
            run([
                { actorFullName: 'owner/a', build: stored },
                { actorFullName: 'owner/a', build: { ...stored } },
            ]),
        ).resolves.toStrictEqual([{ actorFullName: 'owner/a', ...stored }]);
    });

    it('builds an Actor that is also listed without a build', async () => {
        await expect(
            planned([{ actorFullName: 'owner/a', build: 'default' }, { actorFullName: 'owner/a' }]),
        ).resolves.toStrictEqual(['owner/a']);
    });
});

describe('parseVersionGitRepoUrl', () => {
    it.each([
        ['git@github.com:o/r#test:actors/a', { repository: 'git@github.com:o/r', ref: 'test', folder: 'actors/a' }],
        ['git@github.com:o/r#test', { repository: 'git@github.com:o/r', ref: 'test', folder: '.' }],
        ['git@github.com:o/r', { repository: 'git@github.com:o/r', ref: undefined, folder: '.' }],
        [
            'https://github.com/o/r#feature/x:./actors/a/',
            { repository: 'https://github.com/o/r', ref: 'feature/x', folder: 'actors/a' },
        ],
        ['git@github.com:o/r#:actors/a', { repository: 'git@github.com:o/r', ref: undefined, folder: 'actors/a' }],
    ])('splits %s', (url, expected) => {
        expect(parseVersionGitRepoUrl(url)).toStrictEqual(expected);
    });
});

describe('assertVersionBuildsFromBranch', () => {
    const folder = new RelativeDir('actors/a');
    const check = (versions: ApifyClientTypes.ActorVersion[], branch = 'test', repoUrl = REPO_URL) =>
        assertVersionBuildsFromBranch(ACTOR, makeActorInfo({ versions }), '0.99', { repoUrl, branch, folder });

    it('passes when the version builds the branch, whatever the form of the repository URL', () => {
        expect(() =>
            check([gitVersion('0.99', 'test', 'actors/a')], 'test', 'https://github.com/owner/repo.git'),
        ).not.toThrow();
    });

    it('passes for an Actor at the repository root, with or without a folder in the URL', () => {
        const atRoot = (versions: ApifyClientTypes.ActorVersion[]) =>
            assertVersionBuildsFromBranch(ACTOR, makeActorInfo({ versions }), '0.99', {
                repoUrl: REPO_URL,
                branch: 'test',
                folder: RelativeDir.ROOT,
            });
        expect(() => atRoot([gitVersion('0.99', 'test')])).not.toThrow();
        expect(() => atRoot([gitVersion('0.99', 'test', '.')])).not.toThrow();
    });

    it('asks to create a missing version, with the Git URL to give it', () => {
        expect(() => check([])).toThrow(
            `Version 0.99 doesn't exist. apify-test-tools never creates or changes Actor versions`,
        );
        expect(() => check([])).toThrow(`${REPO_URL}#test:actors/a`);
    });

    it('throws for a version not built from a Git repository', () => {
        expect(() =>
            check([{ versionNumber: '0.99', sourceType: ActorSourceType.SourceFiles, sourceFiles: [] }]),
        ).toThrow('has source type "SOURCE_FILES"');
    });

    it('names the branch to pass when the version builds another branch', () => {
        expect(() => check([gitVersion('0.99', 'test', 'actors/a')], 'feature')).toThrow(
            'branch test, not feature). apify-test-tools never creates or changes Actor versions, so set it up on the ' +
                `platform. Set its Git URL to ${REPO_URL}#feature:actors/a. To build branch test instead, push the code ` +
                'to it and pass --branch test.',
        );
    });

    it('throws when the version builds another folder', () => {
        expect(() => check([gitVersion('0.99', 'test', 'actors/b')])).toThrow('folder actors/b, not actors/a');
    });

    it('throws when the version builds another repository', () => {
        expect(() => check([gitVersion('0.99', 'test', 'actors/a')], 'test', 'git@github.com:fork/repo')).toThrow(
            `repository ${REPO_URL}, not git@github.com:fork/repo`,
        );
    });

    it("throws when the version builds the repository's default branch", () => {
        const version = { ...gitVersion('0.99', 'test'), gitRepoUrl: `${REPO_URL}#:actors/a` };
        expect(() => check([version])).toThrow("branch (the repository's default), not test");
    });
});

describe('assertVersionKeepsDefaultBuildTag', () => {
    const check = (versionNumber: string, versions: ApifyClientTypes.ActorVersion[]) =>
        assertVersionKeepsDefaultBuildTag(ACTOR, makeActorInfo({ versions }), versionNumber);

    it('throws for a test version with the default build tag, which would release its builds', () => {
        expect(() =>
            check('0.99', [gitVersion('0.1', 'master'), gitVersion('0.99', 'test', undefined, { buildTag: 'latest' })]),
        ).toThrow('Version 0.99 has the build tag "latest"');
    });

    it('passes for a test version with another build tag or none', () => {
        expect(() =>
            check('0.99', [gitVersion('0.1', 'master'), gitVersion('0.99', 'test', undefined, { buildTag: 'test' })]),
        ).not.toThrow();
        expect(() => check('0.99', [gitVersion('0.1', 'master'), gitVersion('0.99', 'test')])).not.toThrow();
    });

    it('passes for the default version, whose builds are meant for users', () => {
        expect(() => check('0.1', [gitVersion('0.1', 'master', undefined, { buildTag: 'latest' })])).not.toThrow();
    });
});

describe('assertBranchAtCommit', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('passes while the branch is at the commit', async () => {
        vi.spyOn(Git, 'getRemoteBranchSha').mockResolvedValue('abc');
        await expect(assertBranchAtCommit('test', 'abc', 'before')).resolves.toBeUndefined();
        await expect(assertBranchAtCommit('test', 'abc', 'after')).resolves.toBeUndefined();
    });

    it('asks to push HEAD when the branch is elsewhere before the builds', async () => {
        vi.spyOn(Git, 'getRemoteBranchSha').mockResolvedValue('other');
        await expect(assertBranchAtCommit('test', 'abc', 'before')).rejects.toThrow(
            'Branch test on origin is at other, not at HEAD (abc)',
        );
    });

    it('asks to push HEAD when the branch does not exist', async () => {
        vi.spyOn(Git, 'getRemoteBranchSha').mockResolvedValue(undefined);
        await expect(assertBranchAtCommit('test', 'abc', 'before')).rejects.toThrow(
            "Branch test doesn't exist on origin. Push HEAD to it first (git push --force origin HEAD:refs/heads/test)",
        );
    });

    it('rejects the builds when the branch moved while they built', async () => {
        vi.spyOn(Git, 'getRemoteBranchSha').mockResolvedValue('other');
        await expect(assertBranchAtCommit('test', 'abc', 'after')).rejects.toThrow(
            'Branch test on origin moved from HEAD (abc) to other while the Actors were building',
        );
    });
});

describe('runBuilds', () => {
    const TOKEN_ENV_VAR = 'APIFY_TOKEN_RUN';
    const actorConfig = { actorFullName: ACTOR, tokenEnvVar: TOKEN_ENV_VAR, folder: RelativeDir.ROOT } as ActorConfig;
    const startBuild = vi.fn(async () => ({ id: 'new-build', actId: 'raw-id', buildNumber: '0.99.7' }));
    const createVersion = vi.fn();
    const updateVersion = vi.fn();

    beforeEach(() => {
        vi.stubEnv(TOKEN_ENV_VAR, 'token');
        vi.spyOn(logger, 'info').mockImplementation(() => undefined);
        vi.mocked(ApifyClient).mockImplementation(function () {
            return {
                actor: () => ({
                    get: async () =>
                        makeActorInfo({ versions: [gitVersion('0.1', 'master'), gitVersion('0.99', 'test')] }),
                    versions: () => ({ create: createVersion }),
                    version: () => ({ update: updateVersion }),
                    build: startBuild,
                }),
                build: () => ({ waitForFinish: async () => ({ status: 'SUCCEEDED', buildNumber: '0.99.7' }) }),
            };
        } as never);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    const run = async (options: Partial<Parameters<typeof runBuilds>[0]> = {}) =>
        runBuilds({
            actorConfigs: [actorConfig],
            versionNumber: '0.99',
            repoUrl: REPO_URL,
            shouldVerifyRepoUrl: true,
            branch: 'test',
            dryRun: false,
            ...options,
        });

    it('only starts a build of the version, without changing the Actor', async () => {
        await expect(run()).resolves.toStrictEqual([
            { buildId: 'new-build', actorRawId: 'raw-id', buildNumber: '0.99.7', actorFullName: ACTOR },
        ]);
        expect(startBuild).toHaveBeenCalledWith('0.99', { useCache: true });
        expect(createVersion).not.toHaveBeenCalled();
        expect(updateVersion).not.toHaveBeenCalled();
    });

    it('starts no build when a version builds another branch', async () => {
        await expect(run({ branch: 'feature' })).rejects.toThrow('pass --branch test');
        expect(startBuild).not.toHaveBeenCalled();
    });

    it('checks the branch is at the expected commit before and after the builds', async () => {
        const remoteSha = vi.spyOn(Git, 'getRemoteBranchSha').mockResolvedValue('head-sha');
        await expect(run({ expectedCommit: 'head-sha' })).resolves.toHaveLength(1);
        expect(remoteSha).toHaveBeenCalledTimes(2);
        expect(remoteSha).toHaveBeenCalledWith('test');
    });

    it('starts no build when the branch is not at the expected commit', async () => {
        vi.spyOn(Git, 'getRemoteBranchSha').mockResolvedValue('other-sha');
        await expect(run({ expectedCommit: 'head-sha' })).rejects.toThrow('not at HEAD (head-sha)');
        expect(startBuild).not.toHaveBeenCalled();
    });

    it('also checks the branch in a dry run, which reads it only once', async () => {
        const remoteSha = vi.spyOn(Git, 'getRemoteBranchSha').mockResolvedValue('head-sha');
        await expect(run({ expectedCommit: 'head-sha', dryRun: true })).resolves.toMatchObject({ dryRun: true });
        expect(remoteSha).toHaveBeenCalledTimes(1);
        expect(startBuild).not.toHaveBeenCalled();
    });

    it('fails when the branch moved while the Actors were building', async () => {
        vi.spyOn(Git, 'getRemoteBranchSha').mockResolvedValueOnce('head-sha').mockResolvedValueOnce('other-sha');
        await expect(run({ expectedCommit: 'head-sha' })).rejects.toThrow('moved from HEAD (head-sha) to other-sha');
    });

    it('builds a given branch at HEAD, and the checked-out branch without a commit check', async () => {
        const currentBranch = vi.spyOn(Git, 'getCurrentBranch').mockResolvedValue('test');
        vi.spyOn(Git, 'resolveCommitSha').mockResolvedValue('head-sha');
        const remoteSha = vi.spyOn(Git, 'getRemoteBranchSha').mockResolvedValue('head-sha');

        await buildActors({
            actorConfigs: [actorConfig],
            versionNumber: '0.99',
            repoUrl: REPO_URL,
            branch: 'test',
            dryRun: false,
        });
        expect(currentBranch).not.toHaveBeenCalled();
        expect(remoteSha).toHaveBeenCalledTimes(2);

        remoteSha.mockClear();
        await buildActors({ actorConfigs: [actorConfig], versionNumber: '0.99', repoUrl: REPO_URL, dryRun: false });
        expect(currentBranch).toHaveBeenCalled();
        expect(remoteSha).not.toHaveBeenCalled();
    });
});
