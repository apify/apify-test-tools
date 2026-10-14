import type * as ApifyClientTypes from 'apify-client';
import { ActorSourceType } from 'apify-client';
import { describe, expect, it, vi } from 'vitest';

import {
    ApifyBuilder,
    assertRepoUrlMatchesDefaultVersion,
    buildActors,
    resolveDefaultVersion,
    runBuilds,
} from '../../../bin/build.js';
import * as Git from '../../../bin/git.js';
import { logger } from '../../../bin/logger.js';
import type { ActorConfig } from '../../../bin/types.js';

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
    const dryRunBuild = async (versionNumber: string, actorInfo = makeActorInfo()) => {
        vi.spyOn(ApifyBuilder, 'fromActorConfig').mockReturnValue({
            getActorInfo: async () => actorInfo,
        } as unknown as ApifyBuilder);
        const [build] = await runBuilds({
            actorConfigs: [actorConfig],
            versionNumber,
            repoUrl: REPO_URL,
            shouldVerifyRepoUrl: false,
            branch: 'master',
            dryRun: true,
        });
        // A dry run reports the version it would build as the build number
        return build.buildNumber;
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
        expect(branchSpy).not.toHaveBeenCalled();
        expect(repoSpy).not.toHaveBeenCalled();
    });
});
