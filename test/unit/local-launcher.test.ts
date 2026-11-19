import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import { ActorSource } from '../../bin/from-local-files/actor-source.js';
import { localLauncher, plainEnv } from '../../lib/local-launcher.js';

// Where the fake Actors below find the storage library: they have no packages of their own
const storageLibraryRoot = fileURLToPath(new URL('../../package.json', import.meta.url));

const execFileAsync = promisify(execFile);

describe('plainEnv', () => {
    it('drops what the platform sets and keeps the image, the system and the named variables', () => {
        const env = {
            PATH: '/bin',
            APIFY_IS_AT_HOME: '1',
            APIFY_TOKEN: 'secret',
            ACTOR_RUN_ID: 'run',
            APIFY_CHROME_EXECUTABLE_PATH: '/chrome',
            APIFY_MY_OWN: 'mine',
        };

        expect(plainEnv(env, ['APIFY_MY_OWN'])).toStrictEqual({
            PATH: '/bin',
            APIFY_CHROME_EXECUTABLE_PATH: '/chrome',
            APIFY_MY_OWN: 'mine',
        });
    });
});

describe('localLauncher', { timeout: 60_000 }, () => {
    const dirs: string[] = [];
    afterAll(async () => Promise.all(dirs.map(async (dir) => rm(dir, { recursive: true, force: true }))));

    // Stands in for the Apify API: serves the run's input and records what the launcher sends back
    const fakeApi = async (input: object | undefined) => {
        const requests: { method: string; url: string; contentType?: string; authorization?: string; body: string }[] =
            [];
        const read = async (request: IncomingMessage) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(chunk as Buffer);
            return Buffer.concat(chunks).toString();
        };
        const server = createServer((request, response) => {
            void read(request).then((body) => {
                requests.push({
                    method: request.method!,
                    url: request.url!,
                    contentType: request.headers['content-type'],
                    authorization: request.headers.authorization,
                    body,
                });
                const isInput = request.method === 'GET' && request.url === '/v2/key-value-stores/kvs/records/INPUT';
                if (isInput && input === undefined) response.writeHead(404).end();
                else response.writeHead(200).end(isInput ? JSON.stringify(input) : '{}');
            });
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        return { requests, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    };

    // An Actor that reports the environment it was started with and stores one record of each kind
    const launch = async (input: object | undefined) => {
        const sourceDir = await mkdtemp(path.join(tmpdir(), 'launcher-source-'));
        const appDir = await mkdtemp(path.join(tmpdir(), 'launcher-app-'));
        dirs.push(sourceDir, appDir);
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
            const { FileSystemDatasetClient, FileSystemKeyValueStoreClient } = createRequire(${JSON.stringify(storageLibraryRoot)})('@crawlee/fs-storage-native');
            const storage = process.env.CRAWLEE_STORAGE_DIR;
            const inputFile = path.join(storage, 'key_value_stores/default/INPUT.json');
            const input = JSON.parse(await readFile(inputFile, 'utf8').catch(() => 'null'));
            const { APIFY_IS_AT_HOME, APIFY_TOKEN, ACTOR_RUN_ID, APIFY_CHROME_EXECUTABLE_PATH, GREETING } = process.env;
            const dataset = await FileSystemDatasetClient.open(undefined, undefined, 'default', storage);
            await dataset.pushData({ input, APIFY_IS_AT_HOME, APIFY_TOKEN, ACTOR_RUN_ID, APIFY_CHROME_EXECUTABLE_PATH, GREETING });
            const store = await FileSystemKeyValueStoreClient.open(undefined, undefined, 'default', storage);
            await store.setValue('OUTPUT', Buffer.from('{"done":true}'), 'application/json');
            await store.setValue('page', Buffer.from('<p>hi</p>'), 'text/html');
            process.exit(input?.exitCode ?? 0);
            `,
        );
        const files = await ActorSource.dirs(sourceDir)
            .with(localLauncher(['GREETING']))
            .files();
        for (const [name, content] of files) {
            await mkdir(path.dirname(path.join(appDir, name)), { recursive: true });
            await writeFile(path.join(appDir, name), content);
        }

        // What the Actor's Dockerfile does: brings in the storage library the launcher added to the dependencies
        await execFileAsync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: appDir });

        const api = await fakeApi(input);
        const child = spawn('npm', ['start', '--silent'], {
            cwd: appDir,
            stdio: 'ignore',
            env: {
                PATH: process.env.PATH,
                APIFY_API_BASE_URL: api.url,
                APIFY_TOKEN: 'secret',
                APIFY_IS_AT_HOME: '1',
                ACTOR_RUN_ID: 'run',
                ACTOR_DEFAULT_KEY_VALUE_STORE_ID: 'kvs',
                ACTOR_DEFAULT_DATASET_ID: 'ds',
                APIFY_CHROME_EXECUTABLE_PATH: '/chrome',
                GREETING: 'hello',
            },
        });
        const [exitCode] = (await once(child, 'close')) as [number];
        api.server.close();
        return { exitCode, requests: api.requests };
    };

    it('runs the Actor with a plain environment and moves its local storage to the run', async () => {
        const { exitCode, requests } = await launch({ say: 'hi' });

        expect(exitCode).toBe(0);
        expect(requests.every(({ authorization }) => authorization === 'Bearer secret')).toBe(true);

        const pushed = requests.find(({ method, url }) => method === 'POST' && url === '/v2/datasets/ds/items');
        expect(JSON.parse(pushed!.body)).toStrictEqual([
            { input: { say: 'hi' }, APIFY_CHROME_EXECUTABLE_PATH: '/chrome', GREETING: 'hello' },
        ]);

        const records = requests
            .filter(({ method }) => method === 'PUT')
            .map(({ url, contentType, body }) => ({ url, contentType, body }));
        // The input is the run's already, so it isn't sent back
        expect(records).toStrictEqual([
            { url: '/v2/key-value-stores/kvs/records/OUTPUT', contentType: 'application/json', body: '{"done":true}' },
            { url: '/v2/key-value-stores/kvs/records/page', contentType: 'text/html', body: '<p>hi</p>' },
        ]);
    });

    it("exits with the Actor's exit code, and starts it without input when the run has none", async () => {
        expect((await launch({ exitCode: 3 })).exitCode).toBe(3);

        const { exitCode, requests } = await launch(undefined);
        expect(exitCode).toBe(0);
        const pushed = requests.find(({ method }) => method === 'POST');
        expect(JSON.parse(pushed!.body)[0].input).toBeNull();
    });
});
