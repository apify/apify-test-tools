import type { TestContext, TestFunction } from 'vitest';
import { test as vitestTest } from 'vitest';

import type { ActorBuilds } from './actor-builds.js';
import { DEFAULT_TEST_OPTIONS } from './consts.js';
import { extendExpect } from './extend-expect.js';
import type { ActorTestOptions } from './types.js';

/** What a test kind adds to the vitest context, and how to clean it up once the test is over. */
type Fixtures<F> = { fixtures: F; dispose?: () => Promise<void> };

type DefineActorTestOptions<F extends object> = {
    builds: ActorBuilds;
    /** Run every test, built or not. Scheduled tests have no builds to match against. */
    runAll: boolean;
    actorId: string;
    testName: string;
    testOptions?: ActorTestOptions;
    /** Called inside the test, so a failure here fails the test and not the whole file. */
    setup: (context: TestContext, name: string) => Promise<Fixtures<F>> | Fixtures<F>;
    fn: TestFunction<F>;
};

/**
 * The shape shared by every kind of Actor test: skipped unless its Actor was built (or everything runs),
 * named `<actor>: <test>`, run with the default options and handed the extended `expect` together with
 * the fixtures its kind provides.
 */
export const defineActorTest = <F extends object>({
    builds,
    runAll,
    actorId,
    testName,
    testOptions,
    setup,
    fn,
}: DefineActorTestOptions<F>) => {
    const name = `${actorId}: ${testName}`;
    vitestTest.runIf(runAll || builds.has(actorId))(
        name,
        { ...DEFAULT_TEST_OPTIONS, ...testOptions },
        async (context: TestContext) => {
            const { fixtures, dispose } = await setup(context, name);
            const { expect, ...rest } = context;
            try {
                await fn({ expect: extendExpect(expect), ...rest, ...fixtures } as Parameters<TestFunction<F>>[0]);
            } finally {
                await dispose?.();
            }
        },
    );
};
