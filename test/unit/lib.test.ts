import type { Actor, ActorClient, ActorRun } from 'apify-client';
import { ApifyClient } from 'apify-client';
import type { TestContext } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../bin/logger.js';
import { createMemoryQueues, MEMORY_QUEUE_ENV_VAR, startMemoryQueueServer } from '../../bin/memory-queue.js';
import { DEFAULT_TEST_ACTOR_TIMEOUT_SECS } from '../../lib/consts.js';
import { _private } from '../../lib/lib.js';
import { reserveMemory } from '../../lib/memory-queue.js';
import * as UtilsModule from '../../lib/utils.js';

const { createStartRunFn } = _private;

describe('createStartRunFn()', () => {
    const actorCallMock = vi.fn(async () => Promise.resolve({ id: 'fake-run-id' } as ActorRun));
    const testContext = { task: {}, annotate: vi.fn() as TestContext['annotate'] } as TestContext;

    vi.spyOn(UtilsModule, 'sleep').mockResolvedValue(undefined);

    beforeEach(vi.clearAllMocks);

    it('should apply default timeout to actor runs', async () => {
        // Arrange

        vi.spyOn(ApifyClient.prototype, 'actor').mockReturnValue({
            call: actorCallMock as ActorClient['call'],
            get: vi.fn(async () => ({ defaultRunOptions: {} }) as Actor) as ActorClient['get'],
        } as ActorClient);

        // Act
        await createStartRunFn(new ApifyClient({ token: 'fake-token' }), '123', testContext)({ input: {} });

        // Assert
        expect(actorCallMock).toHaveBeenCalledTimes(1);
        expect(actorCallMock).toHaveBeenCalledWith(
            {},
            { build: undefined, log: null, timeout: DEFAULT_TEST_ACTOR_TIMEOUT_SECS },
        );
    });

    it('should respect the default actor run timeout if less', async () => {
        // Arrange
        vi.spyOn(ApifyClient.prototype, 'actor').mockReturnValue({
            call: actorCallMock as ActorClient['call'],
            get: vi.fn(async () => ({ defaultRunOptions: { timeoutSecs: 60 } }) as Actor) as ActorClient['get'],
        } as ActorClient);

        // Act
        await createStartRunFn(new ApifyClient({ token: 'fake-token' }), '123', testContext)({ input: {} });

        // Assert
        expect(actorCallMock).toHaveBeenCalledTimes(1);
        expect(actorCallMock).toHaveBeenCalledWith({}, { build: undefined, log: null, timeout: 60 });
    });

    it('keeps an Actor default run timeout of 0, which is no timeout', async () => {
        vi.spyOn(ApifyClient.prototype, 'actor').mockReturnValue({
            call: actorCallMock as ActorClient['call'],
            get: vi.fn(async () => ({ defaultRunOptions: { timeoutSecs: 0 } }) as Actor) as ActorClient['get'],
        } as ActorClient);

        await createStartRunFn(new ApifyClient({ token: 'fake-token' }), '123', testContext)({ input: {} });

        expect(actorCallMock).toHaveBeenCalledWith({}, { build: undefined, log: null, timeout: 0 });
    });

    describe('under the memory queue of test', () => {
        let server: Awaited<ReturnType<typeof startMemoryQueueServer>>;

        beforeEach(async () => {
            vi.spyOn(logger, 'info').mockImplementation(() => undefined);
            server = await startMemoryQueueServer(createMemoryQueues({ maxMemoryGbytes: 4 }), {
                TESTER_APIFY_TOKEN: 'fake-token',
            });
            vi.stubEnv(MEMORY_QUEUE_ENV_VAR, server.address);
            vi.stubEnv('TESTER_APIFY_TOKEN', 'fake-token');
        });
        afterEach(async () => {
            await server.close();
            vi.unstubAllEnvs();
            if (vi.isMockFunction(Date.now)) vi.mocked(Date.now).mockRestore();
        });

        // Lets the queue see the run that asks for memory
        const settle = async () =>
            new Promise((resolve) => {
                setTimeout(resolve, 10);
            });

        /** Holds all the memory, and frees it as if `waitedMs` passed meanwhile */
        const holdMemory = async () => {
            const releaseFirst = await reserveMemory('TESTER_APIFY_TOKEN', 4096);
            const realNow = Date.now.bind(Date);
            let waitedMs = 0;
            vi.spyOn(Date, 'now').mockImplementation(() => realNow() + waitedMs);
            return async (passedMs: number) => {
                await settle();
                waitedMs = passedMs;
                releaseFirst();
            };
        };

        const startRun = async (
            defaultMemoryMbytes: number,
            {
                memory,
                timeoutSecs,
                testTimeoutMs,
            }: { memory?: number; timeoutSecs?: number; testTimeoutMs?: number } = {},
        ) => {
            vi.spyOn(ApifyClient.prototype, 'actor').mockReturnValue({
                call: actorCallMock as ActorClient['call'],
                get: vi.fn(
                    async () => ({ defaultRunOptions: { memoryMbytes: defaultMemoryMbytes, timeoutSecs } }) as Actor,
                ) as ActorClient['get'],
            } as ActorClient);
            return createStartRunFn(new ApifyClient({ token: 'fake-token' }), '123', {
                ...testContext,
                task: { ...testContext.task, timeout: testTimeoutMs },
            } as TestContext)({ input: {}, options: { memory } });
        };

        it("starts a run that fits the budget with the Actor's default memory", async () => {
            await startRun(4096);
            expect(actorCallMock).toHaveBeenCalledTimes(1);
        });

        it('does not start a run whose default memory is over the budget', async () => {
            await expect(startRun(8192)).rejects.toThrow('The run was not started');
            expect(actorCallMock).not.toHaveBeenCalled();
        });

        it('gives a 1-hour test that waited 10 minutes a run timeout of the time it has left', async () => {
            const freeAfter = await holdMemory();
            const run = startRun(4096);
            await freeAfter(10 * 60 * 1000);
            await run;
            expect(actorCallMock).toHaveBeenCalledWith({}, expect.objectContaining({ timeout: 3600 - 600 - 60 }));
        });

        it('keeps the Actor default when the test has more time left than it', async () => {
            const freeAfter = await holdMemory();
            const run = startRun(4096, { timeoutSecs: 1800 });
            await freeAfter(10 * 60 * 1000);
            await run;
            expect(actorCallMock).toHaveBeenCalledWith({}, expect.objectContaining({ timeout: 1800 }));
        });

        it('starts a run with the time the test has left after a long wait under a short Actor default', async () => {
            const freeAfter = await holdMemory();
            const run = startRun(4096, { timeoutSecs: 1800 });
            await freeAfter(40 * 60 * 1000);
            await run;
            expect(actorCallMock).toHaveBeenCalledWith({}, expect.objectContaining({ timeout: 3600 - 2400 - 60 }));
        });

        it('starts a run in a 2-hour test that waited 61 minutes', async () => {
            const freeAfter = await holdMemory();
            const run = startRun(4096, { testTimeoutMs: 2 * 60 * 60 * 1000 });
            await freeAfter(61 * 60 * 1000);
            await run;
            expect(actorCallMock).toHaveBeenCalledWith({}, expect.objectContaining({ timeout: 7200 - 3660 - 60 }));
        });

        it('does not start a run when a 10-minute test timed out while it waited for memory', async () => {
            const freeAfter = await holdMemory();
            const run = startRun(4096, { testTimeoutMs: 10 * 60 * 1000 });
            await freeAfter(11 * 60 * 1000);
            await expect(run).rejects.toThrow('the test has less than a minute left');
            expect(actorCallMock).not.toHaveBeenCalled();
        });

        it('does not start a run when the default 1-hour test timed out while it waited for memory', async () => {
            const freeAfter = await holdMemory();
            const run = startRun(4096);
            await freeAfter(60 * 60 * 1000);
            await expect(run).rejects.toThrow('the test has less than a minute left');
            expect(actorCallMock).not.toHaveBeenCalled();
        });

        it('counts the memory the test gives the run over the default', async () => {
            await expect(startRun(1024, { memory: 8192 })).rejects.toThrow('The run was not started');
            expect(actorCallMock).not.toHaveBeenCalled();
        });
    });
});
