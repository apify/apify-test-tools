import type { ApifyClient } from 'apify-client';
import type { TestContext } from 'vitest';

import type { ActorBuilds } from './actor-builds.js';
import { DATASET_SYNC_DELAY_MS, DEFAULT_TEST_ACTOR_TIMEOUT_SECS } from './consts.js';
import { RunTestResult } from './run-test-result.js';
import type { RunOptions } from './types.js';
import { generateRunLink, getActorPrefilledInput, sleep } from './utils.js';

export const createStartRunFn = <T>(
    apifyClient: ApifyClient,
    builds: ActorBuilds,
    actorId: string,
    testContext: TestContext,
) => {
    const { annotate, task } = testContext;
    const actorConfig = builds.get(actorId);
    const build = actorConfig?.buildNumber;
    const buildId = actorConfig?.buildId;
    return async (runOptions: RunOptions<T>) => {
        const { input, options, prefilledInput, runId } = runOptions;

        if (runId) {
            const run = await apifyClient.run(runId).get();
            if (!run) {
                throw new Error(`Run with id "${runId}" doesn't exist`);
            }
            return new RunTestResult(apifyClient, run);
        }

        const actorInput = {
            ...(prefilledInput && (await getActorPrefilledInput(apifyClient, actorId, buildId))),
            ...input,
        };

        const actor = apifyClient.actor(actorId);
        const actorInfo = await actor.get();
        const timeout = Math.min(
            actorInfo?.defaultRunOptions?.timeoutSecs ?? DEFAULT_TEST_ACTOR_TIMEOUT_SECS,
            DEFAULT_TEST_ACTOR_TIMEOUT_SECS,
        );

        const actorOptions = { timeout, build, log: null, ...options };
        const run = await actor.call(actorInput, actorOptions);

        const runLink = generateRunLink(run);
        await annotate(`${task.name} - ${runLink}`, 'run_link');
        // @ts-expect-error: `TaskMeta` cannot be retyped
        task.meta = {
            runId: run.id,
            runLink,
            actorId: actorConfig?.actorFullName ?? actorId,
        };

        // waiting for dataset and statistics to sync, the Apify platform is only eventually consistent.
        await sleep(DATASET_SYNC_DELAY_MS);

        return new RunTestResult(apifyClient, run);
    };
};
