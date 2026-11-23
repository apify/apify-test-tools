import net from 'node:net';

import { ApifyClient } from 'apify-client';

import { APIFY_ENV_VARS } from '@apify/consts';

import { logger } from './logger.js';

/**
 * The env var `test` gives vitest with the address of its memory queue. The lib asks it for room before each run.
 * A lib that doesn't know it starts its runs at once, as before.
 */
export const MEMORY_QUEUE_ENV_VAR = 'APIFY_TEST_TOOLS_MEMORY_QUEUE';

/**
 * Runs jobs while the memory they hold fits the budget, and the others in the order they came as memory frees up.
 * A job waits for the ones before it even when it would fit already, so a large job is not passed over forever.
 */
export class MemoryQueue {
    private usedMbytes = 0;
    private readonly waiting: { memoryMbytes: number; start: () => void }[] = [];

    constructor(
        readonly budgetMbytes: number,
        private readonly budgetSource: string,
    ) {}

    run = async <T>(memoryMbytes: number, job: () => Promise<T>): Promise<T> => {
        if (memoryMbytes > this.budgetMbytes) {
            throw new Error(
                `It needs ${formatGbytes(memoryMbytes)} of memory, more than the budget of ` +
                    `${formatGbytes(this.budgetMbytes)} (${this.budgetSource}). Free up memory on the account or ` +
                    'raise --max-memory-gbytes.',
            );
        }
        if (this.waiting.length > 0 || this.usedMbytes + memoryMbytes > this.budgetMbytes) {
            logger.info(
                `Waiting for ${formatGbytes(memoryMbytes)} of memory, ${formatGbytes(this.usedMbytes)} of ` +
                    `${formatGbytes(this.budgetMbytes)} is in use`,
            );
            // startWaiting reserves its memory before it starts it
            await new Promise<void>((start) => {
                this.waiting.push({ memoryMbytes, start });
            });
        } else {
            this.usedMbytes += memoryMbytes;
        }
        try {
            return await job();
        } finally {
            this.usedMbytes -= memoryMbytes;
            this.startWaiting();
        }
    };

    private startWaiting() {
        while (this.waiting.length > 0 && this.usedMbytes + this.waiting[0].memoryMbytes <= this.budgetMbytes) {
            const next = this.waiting.shift()!;
            // Reserved here, not when its job resumes, so the next turn of the loop sees the memory as taken
            this.usedMbytes += next.memoryMbytes;
            next.start();
        }
    }
}

const formatGbytes = (mbytes: number) => `${Number((mbytes / 1024).toFixed(2))} GB`;

type LimitsGetter = (token: string) => Promise<{ maxMbytes: number; usedMbytes: number } | undefined>;

const getAccountMemory: LimitsGetter = async (token) => {
    const client = new ApifyClient({ token, baseUrl: process.env[APIFY_ENV_VARS.API_BASE_URL] || undefined });
    const account = await client.user('me').limits();
    if (!account) return undefined;
    return {
        maxMbytes: account.limits.maxActorMemoryGbytes * 1024,
        usedMbytes: account.current.actorMemoryGbytes * 1024,
    };
};

/**
 * One queue per Apify account, which is where the platform counts the memory. An account is known by its token.
 * The budget is `--max-memory-gbytes` when given, else the memory the account has free when its first job asks.
 * When the account's limits can't be read, e.g. with a token scoped to certain Actors, its jobs start at once,
 * as they did before there was a queue.
 */
export const createMemoryQueues = ({
    maxMemoryGbytes,
    getAccountMemory: getMemory = getAccountMemory,
}: {
    maxMemoryGbytes?: number;
    getAccountMemory?: LimitsGetter;
}) => {
    const queues = new Map<string, Promise<MemoryQueue>>();

    const createQueue = async (token: string, accountName: string): Promise<MemoryQueue> => {
        if (maxMemoryGbytes !== undefined) {
            return new MemoryQueue(maxMemoryGbytes * 1024, '--max-memory-gbytes');
        }
        let memory: Awaited<ReturnType<LimitsGetter>>;
        try {
            memory = await getMemory(token);
        } catch (error) {
            logger.debug(`Reading the account limits failed: ${(error as Error).message}`);
        }
        if (!memory) {
            logger.warn(
                `Could not read the memory limit of the account of ${accountName}, so its jobs start without waiting ` +
                    'for memory. Pass --max-memory-gbytes to set a budget.',
            );
            return new MemoryQueue(Infinity, 'no limit');
        }
        const freeMbytes = memory.maxMbytes - memory.usedMbytes;
        logger.info(
            `Memory budget for the account of ${accountName}: ${formatGbytes(freeMbytes)}, its free memory ` +
                `(${formatGbytes(memory.usedMbytes)} of ${formatGbytes(memory.maxMbytes)} in use)`,
        );
        return new MemoryQueue(freeMbytes, 'the free memory of the account');
    };

    /** The queue of the account the token belongs to. `accountName` names it in the logs, e.g. an Actor or env var. */
    return async (token: string, accountName: string): Promise<MemoryQueue> => {
        if (!queues.has(token)) queues.set(token, createQueue(token, accountName));
        return queues.get(token)!;
    };
};

type MemoryQueues = ReturnType<typeof createMemoryQueues>;

/**
 * Serves the queues to the lib in the vitest workers, which run in processes of their own. A worker connects and
 * sends `{ "tokenEnvVar": ..., "memoryMbytes": ... }` on one line. The answer is `{ "start": true }` once the memory
 * is reserved, or `{ "error": ... }`. The memory stays reserved until the worker closes the connection, also when it
 * dies, so a crashed test can't hold memory forever.
 */
export const startMemoryQueueServer = async (queues: MemoryQueues, env: NodeJS.ProcessEnv) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.setEncoding('utf8');
        let buffered = '';
        const onData = (chunk: string) => {
            buffered += chunk;
            const lineEnd = buffered.indexOf('\n');
            if (lineEnd === -1) return;
            socket.off('data', onData);
            void reserve(socket, buffered.slice(0, lineEnd));
        };
        socket.on('data', onData);
        // A worker that goes away while waiting just closes the connection, which needs no handling beyond this
        socket.on('error', (error) => logger.debug(`Memory queue connection failed: ${error.message}`));
    });

    const reserve = async (socket: net.Socket, line: string) => {
        const closed = new Promise<void>((resolve) => {
            socket.once('close', resolve);
        });
        try {
            const { tokenEnvVar, memoryMbytes } = JSON.parse(line) as { tokenEnvVar: string; memoryMbytes: number };
            const token = env[tokenEnvVar];
            if (!token) throw new Error(`${tokenEnvVar} is not set`);
            const queue = await queues(token, tokenEnvVar);
            await queue.run(memoryMbytes, async () => {
                // Not started when the worker left while it waited
                if (socket.destroyed) return;
                socket.write(`${JSON.stringify({ start: true })}\n`);
                await closed;
            });
        } catch (error) {
            socket.end(`${JSON.stringify({ error: (error as Error).message })}\n`);
        }
    };

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as net.AddressInfo;
    return {
        address: `127.0.0.1:${port}`,
        close: async () => {
            const closed = new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
            // A worker vitest left behind would keep its connection, and `close` waiting, forever
            for (const socket of sockets) socket.destroy();
            await closed;
        },
    };
};
