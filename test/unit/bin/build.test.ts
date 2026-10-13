import type * as ApifyClientTypes from 'apify-client';
import { ActorSourceType } from 'apify-client';
import { describe, expect, it, vi } from 'vitest';

import {
    assertRepoUrlMatchesDefaultVersion,
    buildActors,
    resolveDefaultVersion,
    resolveVersionAndTag,
} from '../../../bin/build.js';
import * as Git from '../../../bin/git.js';

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

describe('resolveVersionAndTag', () => {
    const defaults = { defaultVersionNumber: '0.3', defaultBuildTag: 'latest' };

    it('keeps an explicit version and no tag, as builds for tests do', () => {
        expect(resolveVersionAndTag('owner/a', { versionNumber: '0.99' }, defaults)).toStrictEqual({
            versionNumber: '0.99',
            buildTag: undefined,
        });
    });

    it("resolves default to the Actor's own default version and build tag, as releases do", () => {
        expect(
            resolveVersionAndTag('owner/a', { versionNumber: 'default', buildTag: 'default' }, defaults),
        ).toStrictEqual({ versionNumber: '0.3', buildTag: 'latest' });
    });

    it('allows another tag on another version', () => {
        expect(resolveVersionAndTag('owner/a', { versionNumber: '0.99', buildTag: 'beta' }, defaults)).toStrictEqual({
            versionNumber: '0.99',
            buildTag: 'beta',
        });
    });

    it('refuses to give the default build tag to a version that is not the default one', () => {
        expect(() => resolveVersionAndTag('owner/a', { versionNumber: '0.99', buildTag: 'default' }, defaults)).toThrow(
            'Refusing to tag version 0.99 with "latest"',
        );
        expect(() => resolveVersionAndTag('owner/a', { versionNumber: '0.99', buildTag: 'latest' }, defaults)).toThrow(
            'Refusing to tag version 0.99 with "latest"',
        );
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
