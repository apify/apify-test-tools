import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../../bin/logger.js';
import {
    createMemoryQueues,
    MEMORY_QUEUE_ENV_VAR,
    MemoryQueue,
    startMemoryQueueServer,
} from '../../../bin/memory-queue.js';
import { reserveMemory } from '../../../lib/memory-queue.js';

const GB = 1024;

/** A job that runs until `finish` is called, and records whether it started */
const controlledJob = () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const job = {
        started: false,
        finish: () => finish(),
        run: async () => {
            job.started = true;
            await finished;
        },
    };
    return job;
};

// Lets the promises that are ready settle
const settle = async () =>
    new Promise((resolve) => {
        setTimeout(resolve, 10);
    });

describe('MemoryQueue', () => {
    beforeEach(() => {
        vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('starts every job at once while they fit the budget', async () => {
        const queue = new MemoryQueue(8 * GB, 'test');
        const jobs = [controlledJob(), controlledJob()];
        const done = jobs.map(async (job) => queue.run(4 * GB, job.run));
        await settle();
        expect(jobs.map(({ started }) => started)).toEqual([true, true]);
        jobs.forEach((job) => job.finish());
        await Promise.all(done);
    });

    it('starts a job that does not fit once an earlier one finishes', async () => {
        const queue = new MemoryQueue(8 * GB, 'test');
        const [first, second, third] = [controlledJob(), controlledJob(), controlledJob()];
        const done = [queue.run(4 * GB, first.run), queue.run(4 * GB, second.run), queue.run(4 * GB, third.run)];
        await settle();
        expect(third.started).toBe(false);

        first.finish();
        await settle();
        expect(third.started).toBe(true);
        second.finish();
        third.finish();
        await Promise.all(done);
    });

    it('frees the memory of a job that fails', async () => {
        const queue = new MemoryQueue(4 * GB, 'test');
        await expect(queue.run(4 * GB, async () => Promise.reject(new Error('build failed')))).rejects.toThrow(
            'build failed',
        );
        await expect(queue.run(4 * GB, async () => 'next')).resolves.toBe('next');
    });

    it('does not let small jobs pass a large one that waits', async () => {
        const queue = new MemoryQueue(8 * GB, 'test');
        const [running, large, small] = [controlledJob(), controlledJob(), controlledJob()];
        const done = [queue.run(4 * GB, running.run), queue.run(8 * GB, large.run), queue.run(1 * GB, small.run)];
        await settle();
        expect(small.started).toBe(false);

        running.finish();
        await settle();
        expect([large.started, small.started]).toEqual([true, false]);
        large.finish();
        await settle();
        expect(small.started).toBe(true);
        small.finish();
        await Promise.all(done);
    });

    it('fails a job larger than the whole budget and names the budget', async () => {
        const queue = new MemoryQueue(2 * GB, 'the free memory of the account');
        const job = controlledJob();
        await expect(queue.run(4 * GB, job.run)).rejects.toThrow(
            'It needs 4 GB of memory, more than the budget of 2 GB (the free memory of the account)',
        );
        expect(job.started).toBe(false);
    });
});

describe('createMemoryQueues', () => {
    beforeEach(() => {
        vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("defaults the budget to the account's free memory", async () => {
        const queues = createMemoryQueues({
            getAccountMemory: async () => ({ maxMbytes: 32 * GB, usedMbytes: 20 * GB }),
        });
        expect((await queues('token', 'owner/a')).budgetMbytes).toBe(12 * GB);
    });

    it('uses --max-memory-gbytes over the free memory', async () => {
        const getAccountMemory = vi.fn(async () => ({ maxMbytes: 32 * GB, usedMbytes: 0 }));
        const queues = createMemoryQueues({ maxMemoryGbytes: 8, getAccountMemory });
        expect((await queues('token', 'owner/a')).budgetMbytes).toBe(8 * GB);
        expect(getAccountMemory).not.toHaveBeenCalled();
    });

    it('shares one queue between the jobs of an account and keeps accounts apart', async () => {
        const queues = createMemoryQueues({ maxMemoryGbytes: 8 });
        expect(await queues('token-1', 'owner/a')).toBe(await queues('token-1', 'owner/b'));
        expect(await queues('token-1', 'owner/a')).not.toBe(await queues('token-2', 'partner/p'));
    });

    it('starts jobs without waiting, with a warning, when the limits cannot be read', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const queues = createMemoryQueues({
            getAccountMemory: async () => Promise.reject(new Error('insufficient permissions')),
        });
        expect((await queues('scoped-token', 'owner/a')).budgetMbytes).toBe(Infinity);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Pass --max-memory-gbytes to set a budget'));
    });
});

// The CLI's `test` serves the queue, the lib in the vitest workers asks it before each run
describe('memory queue server and the lib', () => {
    let server: Awaited<ReturnType<typeof startMemoryQueueServer>>;

    beforeEach(async () => {
        vi.spyOn(logger, 'info').mockImplementation(() => undefined);
        server = await startMemoryQueueServer(createMemoryQueues({ maxMemoryGbytes: 4 }), { TEST_TOKEN: 'token' });
        vi.stubEnv(MEMORY_QUEUE_ENV_VAR, server.address);
    });
    afterEach(async () => {
        await server.close();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('lets a run start only after the run holding the memory frees it', async () => {
        const releaseFirst = await reserveMemory('TEST_TOKEN', 4 * GB);
        let secondStarted = false;
        const second = reserveMemory('TEST_TOKEN', 4 * GB).then((release) => {
            secondStarted = true;
            return release;
        });
        await settle();
        expect(secondStarted).toBe(false);

        releaseFirst();
        (await second)();
        expect(secondStarted).toBe(true);
    });

    it('fails a run larger than the budget with the reason', async () => {
        await expect(reserveMemory('TEST_TOKEN', 8 * GB)).rejects.toThrow(
            'The run was not started: It needs 8 GB of memory, more than the budget of 4 GB',
        );
    });

    it('fails a run whose token is not set', async () => {
        await expect(reserveMemory('MISSING_TOKEN', 1 * GB)).rejects.toThrow('MISSING_TOKEN is not set');
    });

    it('closes while a worker still holds memory', async () => {
        await reserveMemory('TEST_TOKEN', 4 * GB);
        await expect(server.close()).resolves.toBeUndefined();
        // Already closed, afterEach must not close it again
        server = { ...server, close: async () => undefined };
    });

    it('does not wait without the queue, as under a plain vitest', async () => {
        vi.stubEnv(MEMORY_QUEUE_ENV_VAR, '');
        const release = await reserveMemory('TEST_TOKEN', 64 * GB);
        expect(release).toBeTypeOf('function');
    });
});
