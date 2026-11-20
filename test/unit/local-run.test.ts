import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileSystemKeyValueStoreClient } from '@crawlee/fs-storage-native';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ActorSource } from '../../bin/from-local-files/actor-source.js';
import { extendExpect } from '../../lib/extend-expect.js';
import { LocalRunResult, prepareLocalActor, runLocally } from '../../lib/local-run.js';

// Where the fake Actors below find the storage library: they have no packages of their own
const storageLibraryRoot = fileURLToPath(new URL('../../package.json', import.meta.url));

const roots: string[] = [];
const tempDir = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'local-run-test-'));
    roots.push(dir);
    return dir;
};
afterAll(async () => Promise.all(roots.map(async (dir) => rm(dir, { recursive: true, force: true }))));

describe('runLocally', { timeout: 60_000 }, () => {
    let appDir: string;
    let runsDir: string;

    // An Actor without dependencies of its own, so the test needs neither the SDK nor a network
    beforeAll(async () => {
        const sourceDir = await tempDir();
        await writeFile(
            path.join(sourceDir, 'package.json'),
            JSON.stringify({ type: 'module', scripts: { start: 'node main.js' } }),
        );
        await writeFile(
            path.join(sourceDir, 'main.js'),
            `
            import { readFile } from 'node:fs/promises';
            import { createRequire } from 'node:module';
            import path from 'node:path';
            const { FileSystemDatasetClient } = createRequire(${JSON.stringify(storageLibraryRoot)})('@crawlee/fs-storage-native');
            const storage = process.env.CRAWLEE_STORAGE_DIR;
            const input = JSON.parse(await readFile(path.join(storage, 'key_value_stores/default/INPUT.json'), 'utf8'));
            console.log('at home:', process.env.APIFY_IS_AT_HOME ?? 'no', 'greeting:', process.env.GREETING);
            if (input.hang) await new Promise((resolve) => setTimeout(resolve, 60_000));
            const dataset = await FileSystemDatasetClient.open(undefined, undefined, 'default', storage);
            await dataset.pushData({ echo: input.say });
            process.exit(input.exitCode ?? 0);
            `,
        );
        const root = await tempDir();
        appDir = await prepareLocalActor(ActorSource.dirs(sourceDir), root);
        runsDir = path.join(root, 'runs');
    });

    it('runs the Actor off the platform and satisfies toFinishWith', async () => {
        process.env.APIFY_IS_AT_HOME = '1';
        try {
            const result = await runLocally(appDir, runsDir, { input: { say: 'hi' }, env: { GREETING: 'hello' } });

            expect(await result.getLog()).toContain('at home: no greeting: hello');
            expect((await result.getDataset()).items).toStrictEqual([{ echo: 'hi' }]);
            // Not a crawler and done in no time, so those checks are off
            await extendExpect(expect).hard(result).toFinishWith({
                datasetItemCount: 1,
                duration: null,
                failedRequests: null,
                requestsRetries: null,
            });
        } finally {
            delete process.env.APIFY_IS_AT_HOME;
        }
    });

    it('reports a non-zero exit as a failed run', async () => {
        const result = await runLocally(appDir, runsDir, { input: { exitCode: 3 } });

        expect(result.status).toBe('FAILED');
        expect(result.exitCode).toBe(3);
    });

    it('kills a run that outlives its timeout', async () => {
        const result = await runLocally(appDir, runsDir, { input: { hang: true }, timeoutSecs: 1 });

        expect(result.status).toBe('TIMED-OUT');
        expect((await result.getDataset()).items).toStrictEqual([]);
    });
});

describe('LocalRunResult', () => {
    const resultWith = async (records: Record<string, string>) => {
        const storageDir = await tempDir();
        const store = await FileSystemKeyValueStoreClient.open(undefined, undefined, 'default', storageDir);
        for (const [key, value] of Object.entries(records)) {
            await store.setValue(key, Buffer.from(value), 'application/json');
        }
        return new LocalRunResult('SUCCEEDED', 0, 1, '', storageDir);
    };

    it('reads the statistics of the crawler that replaced the first one, and records with their content type', async () => {
        const result = await resultWith({
            OUTPUT: '{"done":true}',
            CRAWLEE_CRAWLER_STATISTICS_0: '{"requestsFinished":1}',
            CRAWLEE_CRAWLER_STATISTICS_1: '{"requestsFinished":2}',
        });

        expect(await result.getStatistics()).toStrictEqual({ requestsFinished: 2 });
        expect(await result.listKeys()).toStrictEqual([
            'CRAWLEE_CRAWLER_STATISTICS_0',
            'CRAWLEE_CRAWLER_STATISTICS_1',
            'OUTPUT',
        ]);
        const output = await result.getRecord('OUTPUT');
        expect(output?.contentType).toBe('application/json');
        expect(output?.value.toString()).toBe('{"done":true}');
    });

    it('reads a Crawlee 3 store, whose records are bare files named after the key and its type', async () => {
        const storageDir = await tempDir();
        const store = path.join(storageDir, 'key_value_stores', 'default');
        await mkdir(store, { recursive: true });
        await writeFile(path.join(store, 'SDK_CRAWLER_STATISTICS_0.json'), '{"requestsFinished":4}');
        await writeFile(path.join(store, 'shot.png'), Buffer.from([9]));
        const result = new LocalRunResult('SUCCEEDED', 0, 1, '', storageDir);

        expect(await result.getStatistics()).toStrictEqual({ requestsFinished: 4 });
        expect(await result.listKeys()).toStrictEqual(['SDK_CRAWLER_STATISTICS_0.json', 'shot.png']);
        expect((await result.getRecord('shot.png'))?.contentType).toBe('application/octet-stream');
    });

    it('has no statistics, items or records for a run that stored nothing', async () => {
        const result = await resultWith({});

        expect(await result.getStatistics()).toBeUndefined();
        expect((await result.getDataset()).items).toStrictEqual([]);
        expect(await result.getRecord('OUTPUT')).toBeUndefined();
    });
});
