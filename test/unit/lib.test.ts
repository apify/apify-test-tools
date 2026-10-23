import type { ActorRun, ApifyClient } from 'apify-client';
import type { TestContext } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActorBuilds } from '../../lib/actor-builds.js';
import { DEFAULT_TEST_ACTOR_TIMEOUT_SECS } from '../../lib/consts.js';
import { createStartRunFn } from '../../lib/start-run.js';
import * as UtilsModule from '../../lib/utils.js';

describe('createStartRunFn()', () => {
    const actorCallMock = vi.fn(async () => Promise.resolve({ id: 'fake-run-id' } as ActorRun));
    const testContext = { task: {}, annotate: vi.fn() as TestContext['annotate'] } as TestContext;
    const builds = new ActorBuilds([]);

    const clientWithActor = (actorInfo: object) =>
        ({
            actor: () => ({ call: actorCallMock, get: async () => actorInfo }),
            keyValueStore: vi.fn(),
        }) as unknown as ApifyClient;

    vi.spyOn(UtilsModule, 'sleep').mockResolvedValue(undefined);

    beforeEach(vi.clearAllMocks);

    it('should apply default timeout to actor runs', async () => {
        const client = clientWithActor({ defaultRunOptions: {} });

        await createStartRunFn(client, builds, '123', testContext)({ input: {} });

        expect(actorCallMock).toHaveBeenCalledTimes(1);
        expect(actorCallMock).toHaveBeenCalledWith(
            {},
            { build: undefined, log: null, timeout: DEFAULT_TEST_ACTOR_TIMEOUT_SECS },
        );
    });

    it('should respect the default actor run timeout if less', async () => {
        const client = clientWithActor({ defaultRunOptions: { timeoutSecs: 60 } });

        await createStartRunFn(client, builds, '123', testContext)({ input: {} });

        expect(actorCallMock).toHaveBeenCalledTimes(1);
        expect(actorCallMock).toHaveBeenCalledWith({}, { build: undefined, log: null, timeout: 60 });
    });

    it('should run the build made for the Actor, found by full name or raw ID', async () => {
        const client = clientWithActor({ defaultRunOptions: {} });
        const withBuild = new ActorBuilds([
            { actorFullName: 'me/actor', actorRawId: 'rawId', buildId: 'b1', buildNumber: '0.99.4' },
        ]);

        await createStartRunFn(client, withBuild, 'me/actor', testContext)({ input: {} });
        await createStartRunFn(client, withBuild, 'rawId', testContext)({ input: {} });

        expect(actorCallMock).toHaveBeenCalledTimes(2);
        for (const [, options] of actorCallMock.mock.calls as unknown as [unknown, { build: string }][]) {
            expect(options.build).toBe('0.99.4');
        }
    });
});
