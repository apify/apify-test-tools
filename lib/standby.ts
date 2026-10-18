import type { Actor, ActorStandby, ApifyClient, Task } from 'apify-client';
import type { TestContext } from 'vitest';

import type { RunOptions } from './types.js';
import { generateRunLink } from './utils.js';

interface StandbyTask {
    standbyUrl: string;
    taskId: string;
}

/**
 * Creates a task with specific `build` - either `buildNumber` or default.
 *
 * @throws if actor doesn't exist or it doesn't support standby mode.
 */
export const createStandbyTask = async (
    apifyClient: ApifyClient,
    actorId: string,
    buildNumber?: string,
): Promise<StandbyTask> => {
    const actor = apifyClient.actor(actorId);

    const actorInfo = (await actor.get()) as Actor & { standbyUrl?: string };
    if (!actorInfo) {
        throw new Error(`Actor "${actorId}" not found`);
    }

    if (!actorInfo.standbyUrl) {
        throw new Error(`Actor "${actorId}" doesn't support standby mode`);
    }

    if (!actorInfo.actorStandby) {
        throw new Error(`Actor "${actorId} doesn't contain actorStandby options`);
    }
    const { isEnabled, ...defaultActorStandby } = actorInfo.actorStandby;
    delete defaultActorStandby.disableStandbyFieldsOverride;

    const build = buildNumber ?? defaultActorStandby.build;

    const actorStandbyOptions: ActorStandby = {
        ...defaultActorStandby,
        build,
    };

    try {
        const title = `Test task - ${build}`.slice(0, 62);
        const randomValueLength = 15;
        // we try to create unique task name containing only `a-z0-9-` characters and at most 63 characters long
        const randomValue = Math.random().toString(10).slice(2).padEnd(randomValueLength, '0');
        const name = `test-${randomValue.slice(0, randomValueLength)}`;
        const newTask = (await apifyClient.tasks().create({
            actId: actorId,
            actorStandby: actorStandbyOptions,
            description: `Task for testing standby version ${build} of actor "${actorId}"`,
            title,
            name,
        })) as Task & { standbyUrl?: string };

        const { id, standbyUrl } = newTask;

        if (!standbyUrl) {
            throw new Error(`Task "${id} doesn't contain standbyUrl property`);
        }

        return {
            standbyUrl,
            taskId: id,
        };
    } catch (error) {
        throw new Error(`Failed to create task: ${error}`);
    }
};

/**
 * Creates a function that accepts input for a standby actor and sends a request containing the input
 * to the task's standby url.
 */
export const createStartStandbyFn = <I, O>(
    apifyClient: ApifyClient,
    standbyTask: StandbyTask,
    { annotate }: TestContext,
    testName: string,
) => {
    const { standbyUrl, taskId } = standbyTask;
    const annotatedRuns = new Set<string>();

    // We annotate all the runs of the task, though it will be only one run
    // for most of the tests. To avoid annotating the same run multiple times
    // (in case the test calls the standby more than once), we use `annotatedRuns`
    // set to keep track of which runs have already been annotated.
    const annotateStandbyRuns = async () => {
        const runs = (await apifyClient.task(taskId).runs().list()).items;
        for (const run of runs) {
            if (!annotatedRuns.has(run.id)) {
                const runLink = generateRunLink(run);
                await annotate(`${testName} - ${runLink}`, 'run_link');
            }
            annotatedRuns.add(run.id);
        }
    };

    return async ({
        input,
        path = '',
        headers = {},
    }: Pick<RunOptions<I>, 'input'> & { path?: string; headers?: Record<string, string> }) => {
        const response = await fetch(standbyUrl + path, {
            headers: {
                ...headers,
                Authorization: `Bearer ${apifyClient.token}`,
            },
            method: 'POST',
            body: JSON.stringify(input),
        });

        await annotateStandbyRuns();

        const data = (await response.json()) as O;
        return {
            data,
            status: response.status,
            headers: response.headers,
        };
    };
};
