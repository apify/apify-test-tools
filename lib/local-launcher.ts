import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { SourceStep } from '../bin/from-local-files/actor-source.js';

/**
 * Crawlee 3 keeps a record as a bare `<key>.<extension>` file, which the storage library doesn't count as a record.
 * Passed to `open`, this makes it adopt every such file, under its filename: the key keeps the extension. The input
 * is the exception, it's written as `INPUT.json` for either version and stays `INPUT`.
 */
export const ADOPT_BARE_FILES = [
    { key: 'INPUT', files: [{ filename: 'INPUT.json', contentType: 'application/json' }] },
    {
        files: [
            { filename: '*.json', contentType: 'application/json' },
            { filename: '*.txt', contentType: 'text/plain' },
            { filename: '*.html', contentType: 'text/html' },
            { filename: '*', contentType: 'application/octet-stream' },
        ],
    },
];

/** What the platform puts into a run's environment, as opposed to the Actor's image or its author. */
const PLATFORM_ENV_PATTERN = /^(ACTOR|APIFY)_/;
/** Set by the Actor images themselves under the platform's prefixes: where the browser is. */
const IMAGE_ENV = ['APIFY_CHROME_EXECUTABLE_PATH', 'APIFY_DEFAULT_BROWSER_PATH'];

/**
 * The environment a local run gets: `env` without what the platform would have put there, so the SDK and the Actor
 * behave as on somebody's machine. `keep` names survive regardless, for the variables the test itself defined.
 */
export const plainEnv = (env: NodeJS.ProcessEnv, keep: string[] = []): NodeJS.ProcessEnv =>
    Object.fromEntries(
        Object.entries(env).filter(
            ([name]) => keep.includes(name) || IMAGE_ENV.includes(name) || !PLATFORM_ENV_PATTERN.test(name),
        ),
    );

const ACTOR_START_SCRIPT = 'start:actor';

/**
 * The launcher reads the Actor's local storage with the Crawlee storage library in the version this package uses.
 * It's added to the wrapped Actor's dependencies under this name.
 */
const STORAGE_LIBRARY_ALIAS = 'apify-test-tools-storage';
const STORAGE_LIBRARY_VERSION = (
    JSON.parse(
        // Its `package.json` isn't an export of the package, so it's found next to its entry point
        readFileSync(
            path.join(
                path.dirname(createRequire(import.meta.url).resolve('@crawlee/fs-storage-native')),
                'package.json',
            ),
            'utf8',
        ),
    ) as { version: string }
).version;

/**
 * Runs on the platform in place of the Actor's own start command. Its one dependency is the storage library, which
 * `localLauncher` adds to the Actor's. `%KEEP%` and the two constants are filled in from this module, to keep one definition of "plain".
 */
const LAUNCHER = `
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const keep = %KEEP%;
const imageEnv = %IMAGE_ENV%;
const platformEnv = %PLATFORM_ENV_PATTERN%;

const api = (process.env.APIFY_API_BASE_URL ?? 'https://api.apify.com').replace(/\\/+$/, '') + '/v2';
const authorization = 'Bearer ' + process.env.APIFY_TOKEN;
const store = api + '/key-value-stores/' + process.env.ACTOR_DEFAULT_KEY_VALUE_STORE_ID + '/records/';
const dataset = api + '/datasets/' + process.env.ACTOR_DEFAULT_DATASET_ID + '/items';
const call = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { authorization, ...options.headers } });
    if (!response.ok && response.status !== 404) {
        throw new Error(options.method + ' ' + url + ' failed with ' + response.status + ': ' + (await response.text()));
    }
    return response;
};

const storageDir = path.join(await mkdtemp(path.join(tmpdir(), 'apify-local-run-')), 'storage');
const localStore = path.join(storageDir, 'key_value_stores', 'default');
await mkdir(localStore, { recursive: true });

const inputKey = process.env.ACTOR_INPUT_KEY ?? 'INPUT';
const input = await call(store + inputKey);
if (input.ok) await writeFile(path.join(localStore, 'INPUT.json'), Buffer.from(await input.arrayBuffer()));

const env = Object.fromEntries(
    Object.entries(process.env).filter(
        ([name]) => keep.includes(name) || imageEnv.includes(name) || !platformEnv.test(name),
    ),
);
const child = spawn('npm', ['run', '${ACTOR_START_SCRIPT}', '--silent'], {
    stdio: 'inherit',
    env: { ...env, CRAWLEE_STORAGE_DIR: storageDir, APIFY_LOCAL_STORAGE_DIR: storageDir, APIFY_HEADLESS: '1' },
});
const [exitCode] = await once(child, 'close');
console.log('[apify-test-tools] The Actor exited with code ' + exitCode + ', copying its local storage to the run');

// The container is gone after the run, so what the Actor stored locally moves to the run's default storages,
// where the test reads it like any platform run's.
const { FileSystemDatasetClient, FileSystemKeyValueStoreClient } = createRequire(path.resolve('package.json'))(
    '${STORAGE_LIBRARY_ALIAS}',
);

const localDataset = await FileSystemDatasetClient.open(undefined, undefined, 'default', storageDir);
// ponytail: fixed pages of 500 items; split by size instead if an Actor's items come near the API's payload limit
let copiedItems = 0;
for (let offset = 0; ; ) {
    const { items, total } = await localDataset.getData(offset, 500);
    if (items.length > 0) {
        await call(dataset, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(items),
        });
    }
    offset += items.length;
    copiedItems += items.length;
    if (items.length === 0 || offset >= total) break;
}

const localRecords = await FileSystemKeyValueStoreClient.open(undefined, undefined, 'default', storageDir, undefined, %ADOPT%);
let copiedRecords = 0;
for (let start; ; ) {
    const page = await localRecords.listKeys(start, 1000);
    for (const { key } of page.items) {
        // The input is the run's already
        if (key === 'INPUT' || key === inputKey) continue;
        const { value, contentType } = await localRecords.getValue(key);
        await call(store + encodeURIComponent(key), {
            method: 'PUT',
            headers: { 'content-type': contentType },
            body: value,
        });
        copiedRecords += 1;
    }
    if (!page.isTruncated) break;
    start = page.nextExclusiveStartKey;
}

console.log('[apify-test-tools] Copied ' + copiedItems + ' dataset items and ' + copiedRecords + ' records');
process.exit(exitCode ?? 1);
`;

/**
 * A step that makes the Actor run as it would off the platform, on the platform: its start command is replaced by a
 * launcher that starts the original one with a plain environment (see `plainEnv`) and local storage, and afterwards
 * copies the local default dataset and key-value store into the run's own. `keep` names stay in the environment.
 * The Actor's `package.json` gains one dependency, the storage library the launcher reads with.
 */
export const localLauncher =
    (keep: string[] = []): SourceStep =>
    async (files) => {
        const raw = files.get('package.json');
        const packageJson =
            raw &&
            (JSON.parse(raw.toString('utf8')) as {
                scripts?: Record<string, string>;
                dependencies?: Record<string, string>;
            });
        if (!packageJson?.scripts?.start) {
            throw new Error("Running locally on the platform needs a `start` script in the Actor's package.json");
        }
        const launcher = LAUNCHER.replace('%KEEP%', JSON.stringify(keep))
            .replace('%ADOPT%', JSON.stringify(ADOPT_BARE_FILES))
            .replace('%IMAGE_ENV%', JSON.stringify(IMAGE_ENV))
            .replace('%PLATFORM_ENV_PATTERN%', String(PLATFORM_ENV_PATTERN));
        // The launcher rides in `package.json`, the one file every Dockerfile has to copy: one of its own could be
        // left out by a Dockerfile that copies paths by name. It only imports built-ins, which a `data:` module may.
        const encoded = Buffer.from(launcher).toString('base64');
        // Under an alias the library gets a directory of its own, so it can't stand in for the copy the Actor's
        // own dependencies resolve, whatever version that is.
        packageJson.dependencies = {
            ...packageJson.dependencies,
            [STORAGE_LIBRARY_ALIAS]: `npm:@crawlee/fs-storage-native@${STORAGE_LIBRARY_VERSION}`,
        };
        packageJson.scripts[ACTOR_START_SCRIPT] = packageJson.scripts.start;
        packageJson.scripts.start = `node --input-type=module -e "await import('data:text/javascript;base64,${encoded}')"`;
        files.set('package.json', Buffer.from(JSON.stringify(packageJson, null, 4)));
    };
