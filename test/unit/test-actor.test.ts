import type * as Vitest from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy handles: mockFails is called directly as vitestTest.fails(name, opts, fn),
// mockRunIf is called as vitestTest.runIf(condition) and returns mockRunIfFn.
const mockRunIfFn = vi.fn();
const mockRunIf = vi.fn(() => mockRunIfFn);
const mockFails = vi.fn();

// Mock the vitest module so lib.ts picks up our spies when dynamically imported.
// We spread the real module so our test file's own `it`, `describe`, `expect` etc. still work.
// We only replace `test` — `it` remains the real registration function used by this file.
vi.mock('vitest', async (importOriginal) => {
    const actual = await importOriginal<typeof Vitest>();
    return {
        ...actual,
        test: Object.assign(vi.fn(), {
            fails: mockFails,
            runIf: mockRunIf,
        }),
    };
});

const ACTOR_BUILD = { actorName: 'my-actor', actorId: 'abc123', buildNumber: '1.0', buildId: 'build1' };
// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

describe('testActor - fails option', () => {
    beforeEach(() => {
        // Fresh module so env vars read at lib.ts module level are re-evaluated each test.
        vi.resetModules();
        mockRunIf.mockClear();
        mockRunIfFn.mockClear();
        mockFails.mockClear();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('calls vitestTest.fails when fails:true and actor is in the build list', async () => {
        vi.stubEnv('ACTOR_BUILDS', JSON.stringify([ACTOR_BUILD]));

        const { testActor } = await import('../../lib/lib.js');
        testActor('my-actor', 'test name', noop, { fails: true });

        expect(mockFails).toHaveBeenCalledOnce();
        expect(mockRunIf).not.toHaveBeenCalled();
    });

    it('calls vitestTest.runIf(false) when fails:true but actor is not in the build list', async () => {
        vi.stubEnv('ACTOR_BUILDS', JSON.stringify([]));

        const { testActor } = await import('../../lib/lib.js');
        testActor('my-actor', 'test name', noop, { fails: true });

        expect(mockRunIf).toHaveBeenCalledWith(false);
        expect(mockFails).not.toHaveBeenCalled();
    });

    it('calls vitestTest.runIf(true) when no fails option and actor is in the build list', async () => {
        vi.stubEnv('ACTOR_BUILDS', JSON.stringify([ACTOR_BUILD]));

        const { testActor } = await import('../../lib/lib.js');
        testActor('my-actor', 'test name', noop);

        expect(mockRunIf).toHaveBeenCalledWith(true);
        expect(mockFails).not.toHaveBeenCalled();
    });

    it('strips the fails key from options forwarded to vitest', async () => {
        vi.stubEnv('ACTOR_BUILDS', JSON.stringify([ACTOR_BUILD]));

        const { testActor } = await import('../../lib/lib.js');
        testActor('my-actor', 'test name', noop, { fails: true, retry: 2 });

        const [, options] = mockFails.mock.calls[0] as [string, Record<string, unknown>, unknown];
        expect(options).not.toHaveProperty('fails');
        expect(options).toHaveProperty('retry', 2);
    });

    it('calls vitestTest.fails when fails:true and RUN_ALL_PLATFORM_TESTS is set (no build config)', async () => {
        vi.stubEnv('ACTOR_BUILDS', JSON.stringify([]));
        vi.stubEnv('RUN_ALL_PLATFORM_TESTS', '1');

        const { testActor } = await import('../../lib/lib.js');
        testActor('my-actor', 'test name', noop, { fails: true });

        expect(mockFails).toHaveBeenCalledOnce();
        expect(mockRunIf).not.toHaveBeenCalled();
    });
});

describe('testStandbyActor - fails option', () => {
    beforeEach(() => {
        vi.resetModules();
        mockRunIf.mockClear();
        mockRunIfFn.mockClear();
        mockFails.mockClear();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('calls vitestTest.fails when fails:true and actor is in the build list', async () => {
        vi.stubEnv('ACTOR_BUILDS', JSON.stringify([ACTOR_BUILD]));

        const { testStandbyActor } = await import('../../lib/lib.js');
        testStandbyActor('my-actor', 'test name', noop, { fails: true });

        expect(mockFails).toHaveBeenCalledOnce();
        expect(mockRunIf).not.toHaveBeenCalled();
    });
});
