import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ActorRun, ApifyClient } from 'apify-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ActorSource } from '../../lib/ad-hoc.js';
import { RunTestResult } from '../../lib/run-test-result.js';

describe('ActorSource', () => {
    let packs: { name: string; filename: string }[];

    beforeAll(async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'packs-'));
        packs = [
            { name: 'apify', filename: path.join(dir, 'apify-1.0.0.tgz') },
            { name: '@crawlee/core', filename: path.join(dir, 'crawlee-core-4.0.0.tgz') },
        ];
        await Promise.all(packs.map(async ({ filename }) => writeFile(filename, 'tgz')));
    });

    /** An actor dir holding just the given `package.json`. */
    const actorDir = async (pkg: object) => {
        const dir = await mkdtemp(path.join(tmpdir(), 'actor-'));
        await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
        return dir;
    };

    it('overlays later directories and pins direct and transitive dependencies to the tarballs', async () => {
        const base = await actorDir({ dependencies: { apify: '*' } });
        const overlay = await actorDir({ dependencies: { apify: '*', cheerio: '^1' } });
        const files = await ActorSource.dirs(base, overlay).pin(packs).files();

        expect(JSON.parse(files.get('package.json')!.toString())).toStrictEqual({
            dependencies: { apify: 'file:./packages/apify-1.0.0.tgz', cheerio: '^1' },
            overrides: {
                apify: 'file:./packages/apify-1.0.0.tgz',
                '@crawlee/core': 'file:./packages/crawlee-core-4.0.0.tgz',
            },
        });
        expect(files.get('packages/apify-1.0.0.tgz')!.toString()).toBe('tgz');
    });

    it('writes pnpm overrides under the pnpm key and honors `only`', async () => {
        const files = await ActorSource.dirs(await actorDir({ pnpm: { overrides: { tar: '^7' } } }))
            .pin(packs, { manager: 'pnpm', only: ['@crawlee/core'] })
            .files();

        expect(JSON.parse(files.get('package.json')!.toString())).toStrictEqual({
            pnpm: { overrides: { tar: '^7', '@crawlee/core': 'file:./packages/crawlee-core-4.0.0.tgz' } },
        });
        expect(files.has('packages/apify-1.0.0.tgz')).toBe(false);
    });
});

describe('ActorSource.main', { timeout: 60_000 }, () => {
    // See test/fixtures/actor-main/README.md.
    const fixtures = path.join(import.meta.dirname, '../fixtures/actor-main');
    const testFile = async (code: string) => {
        const dir = await mkdtemp(path.join(fixtures, 'tmp-'));
        const file = path.join(dir, 'scenario.test.ts');
        await writeFile(file, code);
        await writeFile(path.join(dir, 'package.json'), '{}');
        return { dir, file };
    };
    afterAll(async () => {
        for (const dir of await readdir(fixtures)) {
            if (dir.startsWith('tmp-')) await rm(path.join(fixtures, dir), { recursive: true, force: true });
        }
    });
    // Only its name matters; the source comes from the file.
    const main = async () => undefined;

    it('ships an exported arrow function, transpiled, as the awaited entry point', async () => {
        const { dir, file } = await testFile(`
            import type { Dirent } from 'node:fs';
            import { test } from 'vitest';
            export const main = async (): Promise<void> => {
                const { readdir } = await import('node:fs/promises');
                const entries: Dirent[] = await readdir('.', { withFileTypes: true });
                console.log(entries.length);
            };
            test('x', () => {});
        `);
        const files = await ActorSource.dirs(dir).main(file, main).files();
        const js = files.get('main.js')!.toString();

        expect(js).not.toContain('vitest');
        expect(js).not.toContain('Promise<void>');
        expect(js).not.toContain('Dirent');
        expect(js).toContain('await import("node:fs/promises")');
        expect(js).toContain('await main();');
    });

    it('accepts a function declaration and a custom path', async () => {
        const { dir, file } = await testFile(`async function run() { return 1; }`);
        const run = async () => undefined;
        const files = await ActorSource.dirs(dir).main(file, run, { path: 'src/main.mjs' }).files();

        expect(files.get('src/main.mjs')!.toString()).toContain('async function run()');
    });

    it('rejects an entry point that uses something else from the file', async () => {
        const { dir, file } = await testFile(`
            const helper = () => 1;
            export const main = async () => { console.log(helper()); };
        `);
        await expect(ActorSource.dirs(dir).main(file, main).files()).rejects.toThrow(
            /does not type-check on its own[\s\S]*Cannot find name 'helper'/,
        );
    });

    it('fails when the function is not a top-level declaration of the file', async () => {
        const { dir, file } = await testFile(`const other = 1;`);
        await expect(ActorSource.dirs(dir).main(file, main).files()).rejects.toThrow('No top-level function "main"');
    });
});

describe('RunTestResult.getStatistics', () => {
    const run = { id: 'run', defaultKeyValueStoreId: 'kvs' } as ActorRun;
    const clientWithKeys = (keys: string[]) =>
        ({
            keyValueStore: () => ({
                listKeys: async () => ({ items: keys.map((key) => ({ key })) }),
                getRecord: async (key: string) => ({ value: { key } }),
            }),
        }) as unknown as ApifyClient;

    it('picks the highest-numbered record across crawlee v3 and v4 names', async () => {
        const keys = [
            'INPUT',
            'SDK_CRAWLER_STATISTICS_0',
            'CRAWLEE_CRAWLER_STATISTICS_10',
            'CRAWLEE_CRAWLER_STATISTICS_2',
        ];
        expect(await new RunTestResult(clientWithKeys(keys), run).getStatistics()).toStrictEqual({
            key: 'CRAWLEE_CRAWLER_STATISTICS_10',
        });
    });

    it('is undefined for non-crawler Actors', async () => {
        expect(await new RunTestResult(clientWithKeys(['INPUT']), run).getStatistics()).toBeUndefined();
    });
});
