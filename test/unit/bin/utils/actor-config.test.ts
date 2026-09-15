import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    DEFAULT_CONFIG_FILE_PATH,
    loadActorConfig,
    readConfigFile,
    testablePrivates,
    type TestUtilsActor,
} from '../../../../bin/utils/actor-config.js';
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

// `readConfigFile` reads real fixture trees under `test/fixtures/bin/utils/actor-config/` rather than
// mocking `node:fs`: what is being tested is how config paths, `.actor/actor.json` locations and the
// paths inside them relate to each other on a real filesystem. See that directory's README.md.
//
// Expectations below are built by string concatenation, never by `join`/`resolve` — recomputing them
// with the same functions the code under test uses would assert those functions against themselves.
const FIXTURES = fileURLToPath(new URL('../../../fixtures/bin/utils/actor-config', import.meta.url));
const MONOREPO = `${FIXTURES}/monorepo`;
const MONOREPO_CONFIG = `${MONOREPO}/apify-test-tools.config.json`;

const ALL: { actors: string[]; ignore: string[] } = { actors: [], ignore: [] };

const byName = (configs: Awaited<ReturnType<typeof readConfigFile>>, fullName: string) =>
    configs.find((config) => config.actorFullName === fullName);

describe('readConfigFile', () => {
    describe('a monorepo of actors', () => {
        it('returns every actor and loads actor.json', async () => {
            const result = await readConfigFile(ALL, MONOREPO_CONFIG);
            const names = result.map((config) => config.actorFullName);

            expect(names).toHaveLength(4);
            expect(names).toContain('owner/minimal');
            expect(names).toContain('owner/full');
            expect(names).toContain('other-owner/leaf');
            expect(names).toContain('owner/dotted');
            expect(result.find((x) => x.actorFullName === 'owner/minimal')).toMatchObject({
                actorConfig: {
                    name: 'minimal',
                },
            });
        });

        it('resolves every path-carrying field and leaves inline definitions untouched', async () => {
            const result = await readConfigFile(ALL, MONOREPO_CONFIG);
            const actorDir = `${MONOREPO}/actors/full`;

            expect(result.find((x) => x.actorFullName === 'owner/full')?.actorConfig).toStrictEqual({
                $schema: 'https://apify.com/schemas/v1/actor.json',
                actorSpecification: 1,
                name: 'full',
                title: 'Full Actor',
                description: 'Sets every path-carrying field, half as paths and half as inline definitions.',
                version: '2.3',
                buildTag: 'beta',
                environmentVariables: { LOG_LEVEL: 'DEBUG' },
                // `./Dockerfile` — the Dockerfile lives inside `.actor/`, not beside it
                dockerfile: `${actorDir}/.actor/Dockerfile`,
                // `../../..` — the build context is the whole monorepo, well above the actor folder
                dockerContextDir: MONOREPO,
                readme: `${actorDir}/README.md`,
                changelog: `${actorDir}/CHANGELOG.md`,
                minMemoryMbytes: 256,
                maxMemoryMbytes: 4096,
                defaultMemoryMbytes: 1024,
                input: { title: 'Inline input', type: 'object', schemaVersion: 1, properties: {} },
                inputSchema: `${actorDir}/.actor/input_schema.json`,
                output: { actorOutputSchemaVersion: 1, title: 'Inline output', properties: {} },
                outputSchema: `${actorDir}/.actor/output_schema.json`,
                storages: {
                    keyValueStore: `${actorDir}/.actor/key_value_store_schema.json`,
                    datasets: {
                        default: `${actorDir}/.actor/dataset_schema.json`,
                        errors: { actorSpecification: 1, title: 'Inline errors dataset', fields: {} },
                    },
                },
                usesStandbyMode: true,
                webServerSchema: `${actorDir}/.actor/web_server_schema.json`,
                webServerMcpPath: '/mcp',
            });
        });

        it('resolves an actor nested several levels below the config file', async () => {
            const result = await readConfigFile(ALL, MONOREPO_CONFIG);
            const actorDir = `${MONOREPO}/actors/nested/deep/leaf`;

            expect(result.find((x) => x.actorFullName === 'other-owner/leaf')).toMatchObject({
                folder: actorDir,
                actorFullName: 'other-owner/leaf',
                tokenEnvVar: 'APIFY_TOKEN_LEAF',
                overrideActorContext: [actorDir, `${MONOREPO}/shared/utils`, MONOREPO],
                actorConfig: {
                    name: 'leaf',
                    dockerfile: `${actorDir}/Dockerfile`,
                    dockerContextDir: actorDir,
                },
                dockerContextDir: actorDir,
                contextPaths: [actorDir, `${MONOREPO}/shared/utils`, MONOREPO],
            });
        });

        it('normalizes a folder that only reaches its actor through a parent hop', async () => {
            const result = await readConfigFile(ALL, MONOREPO_CONFIG);
            const dotted = result.find((x) => x.actorFullName === 'owner/dotted');

            // `./actors/dotted/../dotted` in the config file
            expect(dotted?.folder).toBe(`${MONOREPO}/actors/dotted`);
            expect(dotted?.actorConfig).toMatchObject({
                actorSpecification: 1,
                name: 'dotted',
                version: '1.2.3',
                buildTag: 'latest',
                // paths in actor.json may point sideways and far up, not just at the actor folder
                dockerfile: `${MONOREPO}/actors/dotted/docker/Dockerfile`,
                readme: `${MONOREPO}/README.md`,
                // `.` is the `.actor/` directory itself, not the actor folder — no special-casing
                dockerContextDir: `${MONOREPO}/actors/dotted/.actor`,
            });
        });

        // Current behaviour, worth knowing before relying on `contextPaths`: without an override it
        // comes from the resolved `dockerContextDir` and is absolute, with one it is whatever
        // `join`ing against the config file's directory produced. `owner/minimal` above is the
        // absolute case; here the two sit side by side.
        it('takes contextPaths from overrideActorContext when set, and from dockerContextDir otherwise', async () => {
            const result = await readConfigFile(ALL, MONOREPO_CONFIG);
            const full = result.find((x) => x.actorFullName === 'owner/full');
            const minimal = result.find((x) => x.actorFullName === 'owner/minimal');

            expect(full?.contextPaths).toStrictEqual([`${MONOREPO}/actors/full`, `${MONOREPO}/shared`]);
            // the override wins even though it does not contain the actor's own dockerContextDir
            expect(full?.dockerContextDir).toBe(MONOREPO);
            expect(minimal?.contextPaths).toStrictEqual([minimal?.dockerContextDir]);
        });
    });

    describe('where the config file sits', () => {
        it('resolves folders that walk back out of the config file directory', async () => {
            const root = `${FIXTURES}/config-in-subdir`;

            const result = await readConfigFile(ALL, `${root}/config/custom-name.config.json`);

            expect(result.map((config) => config.folder)).toStrictEqual([
                `${root}/actors/sibling`,
                `${root}/root-actor`,
            ]);
            // `../..` from `config/` lands outside the fixture, on the fixtures directory itself
            expect(byName(result, 'owner/sibling')?.contextPaths).toStrictEqual([`${root}/actors`, FIXTURES]);
            expect(byName(result, 'owner/sibling')?.actorConfig.dockerContextDir).toBe(`${root}/actors`);
        });

        it('handles an actor whose .actor/ folder at the root', async () => {
            const root = `${FIXTURES}/actor-at-root`;

            const result = await readConfigFile(ALL, `${root}/apify-test-tools.config.json`);

            expect(result).toMatchObject([
                {
                    folder: root,
                    actorFullName: 'owner/root',
                    tokenEnvVar: 'APIFY_TOKEN_ROOT',
                    actorConfig: {
                        name: 'root',
                        dockerfile: `${root}/Dockerfile`,
                        dockerContextDir: root,
                        input: `${root}/.actor/input_schema.json`,
                    },
                    dockerContextDir: root,
                    contextPaths: [root],
                },
            ]);
        });

        // `folder` is `join`ed against the config file's directory while everything inside
        // `actor.json` is `resolve`d, so a relative config path yields a config-relative `folder`
        // alongside absolute actor.json paths. Callers that pass a relative path get both.
        it('keeps folders relative when the config path is relative, while actor.json paths stay absolute', async () => {
            const relativeConfig = path.relative(process.cwd(), MONOREPO_CONFIG);
            const relativeMonorepo = path.relative(process.cwd(), MONOREPO);

            const result = await readConfigFile(ALL, relativeConfig);

            expect(byName(result, 'owner/minimal')?.folder).toBe(`${relativeMonorepo}/actors/minimal`);
            expect(byName(result, 'owner/full')?.contextPaths).toStrictEqual([
                `${relativeMonorepo}/actors/full`,
                `${relativeMonorepo}/shared`,
            ]);
            expect(byName(result, 'owner/minimal')?.actorConfig.dockerfile).toBe(
                `${MONOREPO}/actors/minimal/Dockerfile`,
            );
        });

        // Assumes this repository has no config file of its own at its root, which it does not —
        // it is the tool, not a repository of actors.
        it('defaults to the config file name in the working directory', async () => {
            await expect(readConfigFile(ALL)).rejects.toThrow(`Expected ${DEFAULT_CONFIG_FILE_PATH} to exist`);
        });
    });

    describe('invalid input', () => {
        it('rethrows the read failure when the config file does not exist', async () => {
            const missing = `${FIXTURES}/this/path/does/not/exist/apify-test-tools.config.json`;

            await expect(readConfigFile(ALL, missing)).rejects.toThrow(`Expected ${missing} to exist`);
        });

        it('rejects a config file that does not match the schema, naming every problem', async () => {
            const promise = readConfigFile(ALL, `${FIXTURES}/invalid-config/apify-test-tools.config.json`);

            await expect(promise).rejects.toThrow('Config file is not valid');
            // every field is reported, not just the first one to fail
            await expect(promise).rejects.toThrow(
                /actors\[0\]\.folder[\s\S]*actors\[0\]\.actorFullName[\s\S]*actors\[0\]\.tokenEnvVar[\s\S]*actors\[0\]\.overrideActorContext/,
            );
        });

        it('rejects two actors sharing a full name, naming the duplicate', async () => {
            await expect(
                readConfigFile(ALL, `${FIXTURES}/duplicate-names/apify-test-tools.config.json`),
            ).rejects.toThrow(/Duplicate actor full names[\s\S]*owner\/twin/);
        });

        it('rejects an actor whose .actor/actor.json is missing, naming the path it looked at', async () => {
            const root = `${FIXTURES}/missing-actor-json`;

            await expect(readConfigFile(ALL, `${root}/apify-test-tools.config.json`)).rejects.toThrow(
                `Expected ${root}/actors/no-actor-json/.actor/actor.json to exist`,
            );
        });

        it('rejects an actor.json that does not match the schema', async () => {
            const promise = readConfigFile(ALL, `${FIXTURES}/invalid-actor-json/apify-test-tools.config.json`);

            await expect(promise).rejects.toThrow(/Actor\.json is not valid/);
            await expect(promise).rejects.toThrow(/actorSpecification[\s\S]*version[\s\S]*minMemoryMbytes/);
        });
    });
});

describe('loadActorConfig', () => {
    it('loads a single actor from its folder, without a config file in play', async () => {
        const config: TestUtilsActor = {
            folder: `${MONOREPO}/actors/minimal`,
            actorFullName: 'owner/minimal',
            tokenEnvVar: 'APIFY_TOKEN_MINIMAL',
        };

        await expect(loadActorConfig(config)).resolves.toMatchObject({
            ...config,
            actorConfig: {
                name: 'minimal',
                dockerfile: `${MONOREPO}/actors/minimal/Dockerfile`,
                dockerContextDir: `${MONOREPO}/actors/minimal`,
                readme: `${MONOREPO}/actors/minimal/README.md`,
            },
            dockerContextDir: `${MONOREPO}/actors/minimal`,
            contextPaths: [`${MONOREPO}/actors/minimal`],
        });
    });

    it('rejects a folder that has no .actor/actor.json', async () => {
        const folder = `${FIXTURES}/missing-actor-json/actors/no-actor-json`;

        await expect(
            loadActorConfig({ folder, actorFullName: 'owner/gone', tokenEnvVar: 'APIFY_TOKEN_GONE' }),
        ).rejects.toThrow(`Expected ${folder}/.actor/actor.json to exist`);
    });
});
