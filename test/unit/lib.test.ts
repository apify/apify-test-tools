import type { Actor, ActorClient, ActorRun } from 'apify-client';
import { ApifyClient } from 'apify-client';
import type { TestContext } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../bin/logger.js';
import { createMemoryQueues, MEMORY_QUEUE_ENV_VAR, startMemoryQueueServer } from '../../bin/memory-queue.js';
import { DEFAULT_TEST_ACTOR_TIMEOUT_SECS } from '../../lib/consts.js';
import { _private } from '../../lib/lib.js';
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
        });

        const startRun = async (defaultMemoryMbytes: number, memory?: number) => {
            vi.spyOn(ApifyClient.prototype, 'actor').mockReturnValue({
                call: actorCallMock as ActorClient['call'],
                get: vi.fn(
                    async () => ({ defaultRunOptions: { memoryMbytes: defaultMemoryMbytes } }) as Actor,
                ) as ActorClient['get'],
            } as ActorClient);
            return createStartRunFn(
                new ApifyClient({ token: 'fake-token' }),
                '123',
                testContext,
            )({ input: {}, options: { memory } });
        };

        it("starts a run that fits the budget with the Actor's default memory", async () => {
            await startRun(4096);
            expect(actorCallMock).toHaveBeenCalledTimes(1);
        });

        it('does not start a run whose default memory is over the budget', async () => {
            await expect(startRun(8192)).rejects.toThrow('The run was not started');
            expect(actorCallMock).not.toHaveBeenCalled();
        });

        it('counts the memory the test gives the run over the default', async () => {
            await expect(startRun(1024, 8192)).rejects.toThrow('The run was not started');
            expect(actorCallMock).not.toHaveBeenCalled();
        });
    });
});
