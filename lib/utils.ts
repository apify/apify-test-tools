import type { Actor, ActorRun, ActorRunListItem, ActorStandby, ApifyClient, Task } from 'apify-client';
import type { TestContext } from 'vitest';

import { RunTestResult } from './run-test-result.js';
import type { ActorBuild, RunOptions } from './types.js';

/**
 * Gets prefilled values for a provided build or, if not provided, uses actor's
 * default build (this is usually `latest`).
 */
export const getActorPrefilledInput = async (
    apifyClient: ApifyClient,
    actorNameOrId: string,
    buildId: string | undefined,
) => {
    if (!buildId) {
        const actorInfo = await apifyClient.actor(actorNameOrId).get();

        const defaultBuildTag = actorInfo?.defaultRunOptions.build;

        const taggedBuild = actorInfo?.taggedBuilds?.[defaultBuildTag || ''];
        // eslint-disable-next-line no-param-reassign --- I think here it is cleaner than creating dummy variable
        buildId = taggedBuild?.buildId;

        if (!buildId) {
            console.error(`Coudn't find default build for actor ${actorNameOrId}. Prefilled values will not be used.`);
            return {};
        }
    }

    const buildInfo = await apifyClient.build(buildId).get();

    const inputSchema = buildInfo?.actorDefinition?.input as
        | {
              properties: Record<string, { prefill?: unknown }>;
          }
        | undefined;

    if (!inputSchema) {
        console.error(
            `Coudn't find input schema definition for actor ${actorNameOrId}, build ${buildId}.`,
            'Prefilled values will not be used',
        );
        return {};
    }

    const prefill: Record<string, unknown> = {};

    for (const [propertyName, propertyValue] of Object.entries(inputSchema.properties)) {
        if (propertyValue.prefill !== undefined) {
            prefill[propertyName] = propertyValue.prefill;
        }
    }

    return prefill;
};

export const sleep = async (ms: number) => {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

export const generateRunLink = (run: ActorRun | ActorRunListItem): string =>
    `https://console.apify.com/view/runs/${run.id}`;

export const createStartRunFn = <T>(
    apifyClient: ApifyClient,
    config: Map<string, ActorBuild>,
    actorNameOrId: string,
    testContext: TestContext,
) => {
    const { annotate, task } = testContext;
    const actorConfig = config.get(actorNameOrId);
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

        const actor = apifyClient.actor(actorNameOrId);

        const actorInput = {
            ...(prefilledInput && (await getActorPrefilledInput(apifyClient, actorNameOrId, buildId))),
            ...input,
        };
        const run = await actor.call(actorInput, { build, log: null, ...options });

        const runLink = generateRunLink(run);
        await annotate(`${task.name} - ${runLink}`, 'run_link');
        // @ts-expect-error: `TaskMeta` cannot be retyped
        task.meta = {
            runId: run.id,
            runLink,
            actorName: actorNameOrId,
        };

        // waiting for datasetItemCount and chargedEventCounts to sync
        await sleep(10_000);

        return new RunTestResult(apifyClient, run);
    };
};

export interface StandbyTask {
    standbyUrl: string;
    taskId: string;
}

/**
 * Creates a function that accepts input for a standby actor and sends a request
 * containing that input to the task's standby URL.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const createStartStandbyFn = <I = any, O = any>(apifyClient: ApifyClient, standbyTask: StandbyTask) => {
    const { standbyUrl } = standbyTask;
    return async ({ input }: Pick<RunOptions<I>, 'input'>) => {
        const response = await fetch(standbyUrl, {
            headers: { Authorization: `Bearer ${apifyClient.token}` },
            method: 'POST',
            body: JSON.stringify(input),
        });

        const data = (await response.json()) as O;
        return { data, status: response.status, headers: response.headers };
    };
};

/**
 * Creates a task with a specific `build` — either `buildNumber` or the actor default.
 *
 * @throws if the actor doesn't exist or doesn't support standby mode.
 */
export const createStandbyTask = async (
    apifyClient: ApifyClient,
    actorNameOrId: string,
    buildNumber?: string,
): Promise<StandbyTask> => {
    const actor = apifyClient.actor(actorNameOrId);

    const actorInfo = (await actor.get()) as Actor & { standbyUrl?: string };
    if (!actorInfo) throw new Error(`Actor "${actorNameOrId}" not found`);
    if (!actorInfo.standbyUrl) throw new Error(`Actor "${actorNameOrId}" doesn't support standby mode`);
    if (!actorInfo.actorStandby) throw new Error(`Actor "${actorNameOrId}" doesn't contain actorStandby options`);

    const { isEnabled, ...defaultActorStandby } = actorInfo.actorStandby;
    delete defaultActorStandby.disableStandbyFieldsOverride;

    const actorStandbyOptions: ActorStandby = {
        ...defaultActorStandby,
        build: buildNumber ?? defaultActorStandby.build,
    };

    try {
        const { build } = actorStandbyOptions;
        const title = `Test task - ${build}:${actorNameOrId}`.slice(0, 62);
        // Unique task name: only `a-z0-9-` chars, at most 63 chars long
        const randomPrefix = Math.floor(Math.random() * 1_000_000);
        const name = `${randomPrefix}${title
            .toLowerCase()
            .replaceAll(/\s+/g, '')
            .replaceAll(/[^a-z0-9-]+/g, '-')}`.slice(0, 62);

        const newTask = (await apifyClient.tasks().create({
            actId: actorNameOrId,
            actorStandby: actorStandbyOptions,
            description: `Task for testing standby version ${build}`,
            title,
            name,
        })) as Task & { standbyUrl?: string };

        const { id, standbyUrl } = newTask;
        if (!standbyUrl) throw new Error(`Task "${id}" doesn't contain standbyUrl property`);

        return { standbyUrl, taskId: id };
    } catch (error) {
        throw new Error(`Failed to create task: ${error}`);
    }
};
