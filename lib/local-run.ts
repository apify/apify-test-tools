import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { FileSystemDatasetClient, FileSystemKeyValueStoreClient } from '@crawlee/fs-storage-native';

import type { ActorSource } from '../bin/from-local-files/actor-source.js';
import { plainEnv } from './local-launcher.js';
import { pickStatisticsKey, type RunOutcome } from './run-test-result.js';
import type { Dataset, SdkCrawlerStatistics } from './types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_SECS = 600;

/**
 * Writes the Actor's source into `<root>/app` and installs its dependencies there, the way its Dockerfile would:
 * with pnpm when `package.json` carries `pnpm.overrides` (npm would ignore them and install the published
 * packages instead of the pinned ones), with npm otherwise.
 */
export const prepareLocalActor = async (source: ActorSource, root: string): Promise<string> => {
    const appDir = path.join(root, 'app');
    for (const [name, content] of await source.files()) {
        const file = path.join(appDir, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
    }

    const packageJson = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8')) as {
        pnpm?: { overrides?: object };
    };
    const [command, ...args] = packageJson.pnpm?.overrides
        ? ['pnpm', 'install', '--prod', '--no-frozen-lockfile']
        : ['npm', 'install', '--omit=dev', '--no-audit', '--no-fund'];
    await execFileAsync(command, args, { cwd: appDir, maxBuffer: 64 * 1024 * 1024 }).catch((error: unknown) => {
        const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
        throw new Error(`Installing the Actor's dependencies with ${command} failed:\n${stdout}${stderr}`);
    });
    return appDir;
};

export interface LocalRunOptions {
    input?: unknown;
    /** Added to the environment of the Actor's process. */
    env?: Record<string, string>;
    /** The process is killed after this long and the run counts as timed out. */
    timeoutSecs?: number;
}

/**
 * Runs the Actor prepared in `appDir` as a process of this machine, off the platform: `npm start` with a plain
 * environment (see `plainEnv`), so the SDK uses its local storage, pointed at a fresh directory under `runsDir`.
 */
export const runLocally = async (
    appDir: string,
    runsDir: string,
    { input, env, timeoutSecs = DEFAULT_TIMEOUT_SECS }: LocalRunOptions = {},
): Promise<LocalRunResult> => {
    await mkdir(runsDir, { recursive: true });
    const storageDir = path.join(await mkdtemp(path.join(runsDir, 'run-')), 'storage');
    if (input !== undefined) {
        const defaultStore = path.join(storageDir, 'key_value_stores', 'default');
        await mkdir(defaultStore, { recursive: true });
        await writeFile(path.join(defaultStore, 'INPUT.json'), JSON.stringify(input));
    }

    const startedAt = Date.now();
    // Its own process group, so a timeout takes down whatever `npm start` spawned too
    const child = spawn('npm', ['start', '--silent'], {
        cwd: appDir,
        detached: true,
        env: {
            ...plainEnv(process.env),
            ...env,
            CRAWLEE_STORAGE_DIR: storageDir,
            APIFY_LOCAL_STORAGE_DIR: storageDir,
            APIFY_HEADLESS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let log = '';
    const collect = (chunk: Buffer) => {
        log += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        process.kill(-child.pid!, 'SIGKILL');
    }, timeoutSecs * 1000);

    // `once` rejects if the process can't be spawned at all
    const [exitCode] = (await once(child, 'close').finally(() => clearTimeout(timer))) as [number | null];

    let status = 'FAILED';
    if (timedOut) status = 'TIMED-OUT';
    else if (exitCode === 0) status = 'SUCCEEDED';
    return new LocalRunResult(status, exitCode, Date.now() - startedAt, log, storageDir);
};

/** The name Crawlee keeps a run's default storages under. */
const DEFAULT_STORAGE = 'default';
const PAGE_SIZE = 1000;

/**
 * A run on this machine, read from the SDK's local storage. It answers what `toFinishWith` and the other matchers
 * ask of a run, so the same assertions cover both runtimes. Nothing is charged locally, so there are no
 * `chargedEventCounts`.
 */
export class LocalRunResult implements RunOutcome {
    constructor(
        readonly status: string,
        readonly exitCode: number | null,
        private readonly durationMillis: number,
        private readonly log: string,
        /** Where the run's datasets, key-value stores and request queues are, for whatever isn't covered here. */
        readonly storageDir: string,
    ) {}

    private openStore = async () =>
        FileSystemKeyValueStoreClient.open(undefined, undefined, DEFAULT_STORAGE, this.storageDir);

    getRunInfo = async () => ({ stats: { durationMillis: this.durationMillis } });

    getLog = async () => this.log;

    /** Every item of the default dataset. */
    getDataset = async <T>(): Promise<Dataset<T>> => {
        const dataset = await FileSystemDatasetClient.open(undefined, undefined, DEFAULT_STORAGE, this.storageDir);
        const items: unknown[] = [];
        for (;;) {
            const page = await dataset.getData(items.length, PAGE_SIZE);
            items.push(...page.items);
            if (page.items.length === 0 || items.length >= page.total) return { items: items as T[] };
        }
    };

    getStatistics = async (): Promise<SdkCrawlerStatistics | undefined> => {
        const key = pickStatisticsKey(await this.listKeys());
        const record = key === undefined ? undefined : await this.getRecord(key);
        return record && (JSON.parse(record.value.toString('utf8')) as SdkCrawlerStatistics);
    };

    /** Keys of the default key-value store. */
    listKeys = async (): Promise<string[]> => {
        const store = await this.openStore();
        const keys: string[] = [];
        for (let start: string | undefined; ; ) {
            const page = await store.listKeys(start, PAGE_SIZE);
            keys.push(...page.items.map(({ key }) => key));
            if (!page.isTruncated) return keys;
            start = page.nextExclusiveStartKey;
        }
    };

    /** A record of the default key-value store, or `undefined` when there is none. */
    getRecord = async (key: string): Promise<{ value: Buffer; contentType: string } | undefined> => {
        const record = await (await this.openStore()).getValue(key);
        return record && { value: record.value, contentType: record.contentType };
    };
}

/** A directory for one Actor's local app and runs. */
export const createLocalRoot = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'apify-local-actor-'));
