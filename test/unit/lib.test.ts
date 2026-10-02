import type { Actor, ActorClient, ActorRun } from 'apify-client';
import { ApifyClient } from 'apify-client';
import type { TestContext } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
        await createStartRunFn('123', testContext)({ input: {} });

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
        await createStartRunFn('123', testContext)({ input: {} });

        // Assert
        expect(actorCallMock).toHaveBeenCalledTimes(1);
        expect(actorCallMock).toHaveBeenCalledWith({}, { build: undefined, log: null, timeout: 60 });
    });
});

describe('shouldRunTest()', () => {
    const loadShouldRunTest = async (env: Record<string, string>) => {
        vi.resetModules();
        for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
        const { _private: reloaded } = await import('../../lib/lib.js');
        vi.unstubAllEnvs();
        return reloaded.shouldRunTest;
    };
    const builds = (actorFullName: string) =>
        JSON.stringify([{ buildId: 'id', actorRawId: `raw-${actorFullName}`, buildNumber: '0.99.1', actorFullName }]);

    it('runs only tests of Actors in ACTOR_BUILDS', async () => {
        const shouldRunTest = await loadShouldRunTest({ ACTOR_BUILDS: builds('owner/a') });
        expect(shouldRunTest('owner/a')).toBe(true);
        expect(shouldRunTest('raw-owner/a')).toBe(true);
        expect(shouldRunTest('owner/b')).toBe(false);
    });

    it('skips Actors in SKIP_ACTOR_BUILDS, even with RUN_ALL_PLATFORM_TESTS', async () => {
        const shouldRunTest = await loadShouldRunTest({
            RUN_ALL_PLATFORM_TESTS: '1',
            SKIP_ACTOR_BUILDS: builds('owner/a'),
        });
        expect(shouldRunTest('owner/a')).toBe(false);
        expect(shouldRunTest('raw-owner/a')).toBe(false);
        expect(shouldRunTest('owner/b')).toBe(true);
    });
});
