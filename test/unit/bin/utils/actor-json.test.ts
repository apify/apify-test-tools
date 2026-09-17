import { describe, expect, it } from 'vitest';

import type { ActorJson } from '../../../../bin/utils/actor-json.js';
import {
    getActorJsonPath,
    parseActorJsonAndResolvePaths,
    resolveActorJsonPaths,
} from '../../../../bin/utils/actor-json.js';
import actorJsonFixture from '../../../fixtures/bin/utils/actor-json/actor.json' with { type: 'json' };

const ACTOR_DIR = 'repo/actors/my-actor';
const ACTOR_JSON_PATH = `${ACTOR_DIR}/.actor/actor.json`;

/** A schema-valid `ActorJson`, i.e. with the defaults `ACTOR_JSON_SCHEMA` would have filled in. */
const actorJson = (overrides: Partial<ActorJson> = {}): ActorJson => ({
    actorSpecification: 1,
    name: 'my-actor',
    version: '1.0',
    buildTag: 'latest',
    dockerfile: '../Dockerfile',
    dockerContextDir: '..',
    readme: '../README.md',
    ...overrides,
});

describe('getActorJsonPath', () => {
    it('points at .actor/actor.json inside the actor folder', () => {
        expect(getActorJsonPath('actors/my-actor')).toBe('actors/my-actor/.actor/actor.json');
    });

    // `readConfigFile` normalizes a `"."` folder to `""`, so the repo-root case reaches here as empty.
    it('handles an actor sitting at the repo root', () => {
        expect(getActorJsonPath('')).toBe('.actor/actor.json');
    });
});

describe('parseActorJsonAndResolvePaths', () => {
    it('applies schema defaults and resolves them against the actor.json directory', () => {
        const result = parseActorJsonAndResolvePaths(actorJsonFixture, ACTOR_JSON_PATH);

        expect(result).toStrictEqual({
            $schema: 'https://apify.com/schemas/v1/actor.json',
            actorSpecification: 1,
            name: 'test-actor',
            version: '1.0',
            // defaults from ACTOR_JSON_SCHEMA, resolved relative to `<actor>/.actor/`
            buildTag: 'latest',
            dockerfile: `${ACTOR_DIR}/Dockerfile`,
            readme: `${ACTOR_DIR}/README.md`,
            // `..` rather than the spec's `.`, so the context dir is the actor folder itself
            dockerContextDir: ACTOR_DIR,
            changelog: undefined,
            input: undefined,
            inputSchema: undefined,
            output: undefined,
            outputSchema: undefined,
            webServerSchema: undefined,
        });
    });

    it('throws when the contents do not match the actor.json schema', () => {
        expect(() => parseActorJsonAndResolvePaths({ name: 'my-actor' }, ACTOR_JSON_PATH)).toThrow(
            'Actor.json is not valid',
        );
    });
});

describe('resolveActorJsonPaths', () => {
    it('resolves every path field against the actor.json directory', () => {
        const config = actorJson({
            dockerContextDir: '../..',
            changelog: '../CHANGELOG.md',
            input: './INPUT.json',
            inputSchema: './input_schema.json',
            output: './OUTPUT.json',
            outputSchema: './output_schema.json',
            webServerSchema: './openapi.json',
            webServerMcpPath: 'mcp',
            storages: { keyValueStore: './kvs_schema.json', dataset: './dataset_schema.json' },
        });

        const result = resolveActorJsonPaths(config, ACTOR_JSON_PATH);

        expect(result).toStrictEqual({
            actorSpecification: 1,
            name: 'my-actor',
            version: '1.0',
            buildTag: 'latest',
            dockerfile: `${ACTOR_DIR}/Dockerfile`,
            readme: `${ACTOR_DIR}/README.md`,
            changelog: `${ACTOR_DIR}/CHANGELOG.md`,
            dockerContextDir: 'repo/actors',
            input: `${ACTOR_DIR}/.actor/INPUT.json`,
            inputSchema: `${ACTOR_DIR}/.actor/input_schema.json`,
            output: `${ACTOR_DIR}/.actor/OUTPUT.json`,
            outputSchema: `${ACTOR_DIR}/.actor/output_schema.json`,
            webServerSchema: `${ACTOR_DIR}/.actor/openapi.json`,
            // an HTTP route, not a path on disk — left exactly as authored
            webServerMcpPath: 'mcp',
            storages: {
                keyValueStore: `${ACTOR_DIR}/.actor/kvs_schema.json`,
                dataset: `${ACTOR_DIR}/.actor/dataset_schema.json`,
            },
        });
    });

    // `dataset` (singular) sits one level higher than the entries of `datasets` (plural); both hold
    // "inline definition or path to it", so both have to be resolved.
    it('resolves each dataset path inside storages.datasets', () => {
        const config = actorJson({
            storages: { datasets: { default: './default_schema.json', extra: { fields: {} } } },
        });

        const result = resolveActorJsonPaths(config, ACTOR_JSON_PATH);

        expect(result.storages).toStrictEqual({
            datasets: { default: `${ACTOR_DIR}/.actor/default_schema.json`, extra: { fields: {} } },
        });
    });

    it('treats the path as a directory when it does not end in actor.json', () => {
        const result = resolveActorJsonPaths(actorJson(), `${ACTOR_DIR}/.actor`);

        const expectedDockerContextDir = ACTOR_DIR;
        const expectedReadme = `${ACTOR_DIR}/README.md`;
        expect(result.dockerContextDir).toBe(expectedDockerContextDir);
        expect(result.readme).toBe(expectedReadme);
    });

    it('leaves inline definitions untouched instead of resolving them as paths', () => {
        const config = actorJson({
            input: { title: 'Input', type: 'object' },
            storages: { dataset: { actorSpecification: 1, fields: {} } },
        });

        const result = resolveActorJsonPaths(config, ACTOR_JSON_PATH);

        expect(result.input).toStrictEqual({ title: 'Input', type: 'object' });
        expect(result.storages).toStrictEqual({ dataset: { actorSpecification: 1, fields: {} } });
    });

    it('does not mutate the config it is given', () => {
        const config = actorJson({ changelog: '../CHANGELOG.md', input: { title: 'Input' } });
        const before = structuredClone(config);

        resolveActorJsonPaths(config, ACTOR_JSON_PATH);

        expect(config).toStrictEqual(before);
    });
});
