import type { ActorClient, ActorRun } from 'apify-client';
import { ApifyClient } from 'apify-client';
import type { TestContext } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

import { _private } from '../../lib/lib.js';
import * as UtilsModule from '../../lib/utils.js';

const { createStartRunFn } = _private;

describe('createStartRunFn()', () => {
    it('should apply default timeout to actor runs', async () => {
        // Arrange
        const actorCallMock = vi.fn(async () => Promise.resolve({ id: 'fake-run-id' } as ActorRun));
        vi.spyOn(ApifyClient.prototype, 'actor').mockReturnValue({
            call: actorCallMock as ActorClient['call'],
        } as ActorClient);
        vi.spyOn(UtilsModule, 'sleep').mockResolvedValue(undefined);

        const testContext = { task: {}, annotate: vi.fn() as TestContext['annotate'] } as TestContext;

        // Act
        await createStartRunFn('123', testContext)({ input: {} });

        // Assert
        expect(actorCallMock).toHaveBeenCalledTimes(1);
        expect(actorCallMock).toHaveBeenCalledWith({}, { build: undefined, log: null, timeout: 3540 });
    });
});
