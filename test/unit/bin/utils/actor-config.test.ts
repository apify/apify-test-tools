import { describe, expect, it } from 'vitest';

import { testablePrivates, type TestUtilsActor } from '../../../../bin/utils/actor-config.js';
import type { ActorJson } from '../../../../bin/utils/actor-json.js';
import { actor } from '../actor-config-fixture.js';

const { enforceUniqueActorFullNames, mergeActorConfig, resolveConfigFilePaths } = testablePrivates;

describe('enforceUniqueActorFullNames', () => {
    it('passes an empty array', () => {
        expect(() => enforceUniqueActorFullNames([])).not.toThrow();
    });
    it('passes an array with unique actor names', () => {
        expect(() => enforceUniqueActorFullNames([actor('owner/foo'), actor('owner/bar')])).not.toThrow();
    });
    it('throws when there are duplicate actor names', () => {
        expect(() => enforceUniqueActorFullNames([actor('owner/foo'), actor('owner/bar'), actor('owner/foo')])).toThrow(
            /.*owner\/foo.*$/m,
        );
    });
});

describe('mergeActorConfig', () => {
    const baseConfig: TestUtilsActor = {
        actorFullName: 'owner/foo',
        folder: 'actors/foo',
        tokenEnvVar: 'APIFY_TOKEN_FOO',
    };
    const actorConfig: ActorJson = {
        actorSpecification: 1,
        name: 'foo',
        version: '1.0',
        buildTag: 'latest',
        dockerfile: '../Dockerfile',
        dockerContextDir: '..',
        readme: '../README.md',
    };
    it('merges actor.json fields', () => {
        expect(mergeActorConfig(baseConfig, actorConfig)).toStrictEqual({
            actorFullName: 'owner/foo',
            folder: 'actors/foo',
            tokenEnvVar: 'APIFY_TOKEN_FOO',
            dockerContextDir: '..',
            contextPaths: ['..'],
            actorConfig: {
                actorSpecification: 1,
                name: 'foo',
                version: '1.0',
                buildTag: 'latest',
                dockerfile: '../Dockerfile',
                readme: '../README.md',
                dockerContextDir: '..',
            },
        });
    });
    it('sets contextPaths based on actor.json and overrideActorContext', () => {
        const merged = mergeActorConfig(baseConfig, actorConfig);
        expect(merged.contextPaths).toStrictEqual(['..']);
        const overridenMerge = mergeActorConfig({ ...baseConfig, overrideActorContext: ['foo/bar'] }, actorConfig);
        expect(overridenMerge.contextPaths).toStrictEqual(['foo/bar']);
    });
    it('normalizes contextPaths', () => {
        const result = mergeActorConfig(
            { ...baseConfig, overrideActorContext: ['foo/.././bar', '../baz'] },
            actorConfig,
        );
        // normalize does not resolve leading ../ since there is no path to resolve it against (and thus determine a parent dir)
        // whereas foo/.././bar resolves to perfectly fine to bar since all its operations are constrained to the relative path
        expect(result.contextPaths).toStrictEqual(['bar', '../baz']);
    });
});

describe('resolveConfigFilePaths', () => {
    it('resolves folder and overrideActorContext', () => {
        const config: TestUtilsActor = {
            actorFullName: 'owner/foo',
            folder: 'my/folder',
            tokenEnvVar: 'APIFY_TOKEN_FOO',
            overrideActorContext: ['some/context', 'otherContext'],
        };
        const result = resolveConfigFilePaths({ actors: [config] }, 'resolve/this');
        expect(result).toStrictEqual({
            actors: [
                {
                    actorFullName: 'owner/foo',
                    folder: 'resolve/this/my/folder',
                    tokenEnvVar: 'APIFY_TOKEN_FOO',
                    overrideActorContext: ['resolve/this/some/context', 'resolve/this/otherContext'],
                },
            ],
        });
    });
    it('resolves stuff that points to the repo root', () => {
        const config: TestUtilsActor = {
            actorFullName: 'owner/foo',
            folder: '.',
            tokenEnvVar: 'APIFY_TOKEN_FOO',
            overrideActorContext: ['../..', 'otherContext'],
        };
        const result = resolveConfigFilePaths({ actors: [config] }, 'resolve/this');
        expect(result).toStrictEqual({
            actors: [
                {
                    actorFullName: 'owner/foo',
                    folder: 'resolve/this',
                    tokenEnvVar: 'APIFY_TOKEN_FOO',
                    overrideActorContext: ['.', 'resolve/this/otherContext'],
                },
            ],
        });
    });
});
