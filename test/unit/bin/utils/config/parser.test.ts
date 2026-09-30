import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { _privates, parseConfigFile } from '../../../../../bin/utils/config/parser.js';
import { CONFIG_FILE_STRATEGY } from '../../../../../bin/utils/config/structures/base.js';
import { GROUPED_PARSER } from '../../../../../bin/utils/config/structures/grouped.js';
import { LEGACY_PARSER } from '../../../../../bin/utils/config/structures/legacy.js';
import { ExistingDir, RelativeDir } from '../../../../../bin/utils/path/repo-relative.js';

const { selectStrategy, verifyConfiguration } = _privates;

let repoDir: string;
const originalCwd = process.cwd();

beforeAll(async () => {
    repoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'apify-test-tools-parser-')));
    for (const folder of [
        'actors/shopify',
        'actors/a',
        'actors/b',
        'actors/c',
        'actors/d',
        'bin',
        'test',
        'collide/collide',
    ]) {
        await fs.mkdir(path.join(repoDir, folder), { recursive: true });
    }
    await fs.writeFile(path.join(repoDir, 'package.json'), '{}');
    process.chdir(repoDir);
});

afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(repoDir, { recursive: true, force: true });
});

const actor = (fields: Record<string, unknown> = {}) => ({
    folder: 'actors/shopify',
    actorFullName: 'myteam/shopify',
    tokenEnvVar: 'APIFY_TOKEN',
    overrideActorContext: undefined,
    ...fields,
});

describe('selectStrategy', () => {
    it('falls back to the legacy strategy when no mode is declared', () => {
        expect(selectStrategy({})).toBe(LEGACY_PARSER);
    });

    it.each([
        [CONFIG_FILE_STRATEGY.LEGACY, LEGACY_PARSER],
        [CONFIG_FILE_STRATEGY.GROUPED, GROUPED_PARSER],
    ])('honours an explicit "%s" mode', (mode, expected) => {
        expect(selectStrategy({ mode })).toBe(expected);
    });

    it('throws on a mode no strategy is registered for', () => {
        expect(() => selectStrategy('some-nonexistent-mode')).toThrow();
    });
});

describe('verifyConfiguration', () => {
    it('resolves the repo root and gets rid of trailing slashes', () => {
        const result = verifyConfiguration([
            { folder: '.', actorFullName: 'myteam/root', tokenEnvVar: 'APIFY_TOKEN', overrideActorContext: undefined },
            {
                folder: 'actors/shopify/',
                actorFullName: 'myteam/shopify',
                tokenEnvVar: 'APIFY_TOKEN',
                overrideActorContext: ['packages/'],
            },
        ]);

        expect(result[0].folder).toBeInstanceOf(ExistingDir);
        expect(result[0].folder.path).toBe('.');
        expect(result[1].folder.path).toBe('actors/shopify');
        expect(result[1].overrideActorContext?.[0]).toBeInstanceOf(RelativeDir);
        expect(result[1].overrideActorContext?.[0].path).toBe('packages');
    });

    it.each([
        ['"." and ""', '.', ''],
        ['weird roots', '', './//'],
        ['a trailing slash', 'actors/shopify', 'actors/shopify/'],
    ])('rejects folders that collide once normalized: %s', (_name, first, second) => {
        expect(() =>
            verifyConfiguration([
                actor({ folder: first, actorFullName: 'myteam/actor-a' }),
                actor({ folder: second, actorFullName: 'myteam/actor-b' }),
            ]),
        ).toThrow(/Duplicate folder/);
    });

    it('quotes a duplicate folder the way it was written, not the way it normalized', () => {
        expect(() =>
            verifyConfiguration([
                actor({ folder: '.', actorFullName: 'myteam/actor-a' }),
                actor({ folder: './', actorFullName: 'myteam/actor-b' }),
            ]),
        ).toThrow('Duplicate folder "./"');
    });

    it('rejects two entries pointing at the same actor', () => {
        expect(() => verifyConfiguration([actor({ folder: 'actors/a' }), actor({ folder: 'actors/b' })])).toThrow(
            /Duplicate actor "myteam\/shopify"/,
        );
    });

    it('treats actorFullName case-sensitively — "myteam/A" is not "myteam/a"', () => {
        expect(() =>
            verifyConfiguration([
                actor({ folder: 'actors/a', actorFullName: 'myteam/abc' }),
                actor({ folder: 'actors/b', actorFullName: 'myteam/ABC' }),
            ]),
        ).not.toThrow();
    });

    it('reports every collision at once instead of stopping at the first', () => {
        const message = (() => {
            try {
                verifyConfiguration([
                    actor({ folder: 'actors/a', actorFullName: 'myteam/actor-a' }),
                    actor({ folder: 'actors/a', actorFullName: 'myteam/actor-b' }),
                    actor({ folder: 'actors/c', actorFullName: 'myteam/actor-c' }),
                    actor({ folder: 'actors/d', actorFullName: 'myteam/actor-c' }),
                ]);
                return '';
            } catch (err) {
                return (err as Error).message;
            }
        })();

        expect(message.split('\n')).toEqual([
            'Duplicate folder "actors/a". Each actor must have a unique folder.',
            'Duplicate actor "myteam/actor-c". Each entry must point at a different actor.',
        ]);
    });

    it('reports both problems for an entry that duplicates a folder and an actor at once', () => {
        expect(() => verifyConfiguration([actor(), actor()])).toThrow(/Duplicate folder[\s\S]*Duplicate actor/);
    });

    it('accepts an empty configuration', () => {
        expect(verifyConfiguration([])).toEqual([]);
    });
});

describe('parseConfigFile', () => {
    it('validates and normalizes paths after resolving the config', () => {
        const [parsed] = parseConfigFile({ actors: [actor({ folder: './bin/', overrideActorContext: ['test/'] })] });
        expect(parsed.folder).toBeInstanceOf(ExistingDir);
        expect(parsed.folder.path).toBe('bin');
        expect(parsed.overrideActorContext?.[0]).toBeInstanceOf(RelativeDir);
        expect(parsed.overrideActorContext?.[0].path).toBe('test');
    });

    it('accepts the repo root as an existing directory', () => {
        expect(parseConfigFile({ actors: [actor({ folder: '' })] })[0].folder.path).toBe('.');
    });

    it('reports invalid paths at their config fields', () => {
        expect(() => parseConfigFile({ actors: [actor({ folder: 'missing-actor-dir' })] })).toThrow(/\[0\]\.folder/);
        expect(() => parseConfigFile({ actors: [actor({ folder: 'package.json' })] })).toThrow(/to be a directory/);
        expect(() =>
            parseConfigFile({ actors: [actor({ folder: 'bin', overrideActorContext: ['../outside'] })] }),
        ).toThrow(/\[0\]\.overrideActorContext\[0\]/);
    });

    it('parses a grouped config file, which needs mode to be stripped', () => {
        expect(
            parseConfigFile({
                mode: CONFIG_FILE_STRATEGY.GROUPED,
                groups: {
                    myteam: {
                        actors: [{ folder: 'actors/shopify/', actorFullName: 'myteam/shopify' }],
                        tokenEnvVar: 'APIFY_TOKEN',
                    },
                },
            }),
        ).toEqual([
            actor({ folder: 'actors/shopify', actorFullName: 'myteam/shopify', overrideActorContext: undefined }),
        ]);
    });

    it('surfaces cross-entry violations from verifyConfiguration', () => {
        expect(() =>
            parseConfigFile({
                actors: [
                    actor({ actorFullName: 'myteam/actor-a', folder: 'collide/collide' }),
                    actor({ actorFullName: 'myteam/actor-b', folder: 'collide/collide' }),
                ],
            }),
        ).toThrow(/Duplicate folder/);
    });

    it('rejects folders that collide after resolving dot segments', () => {
        expect(() =>
            parseConfigFile({
                actors: [
                    actor({ actorFullName: 'myteam/actor-a', folder: 'bin/../test' }),
                    actor({ actorFullName: 'myteam/actor-b', folder: 'test' }),
                ],
            }),
        ).toThrow('Duplicate folder "test"');
    });
});
