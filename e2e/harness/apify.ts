import { ApifyClient } from 'apify-client';

import { type ActorKey, ACTORS } from './scenarios.js';

/**
 * Reads back from the platform what a workflow run actually did: which builds it started and which
 * runs the tests made. This is the ground truth the e2e suite asserts on, rather than the logs.
 */

// The list endpoints return these, but apify-client's collection item types omit some of them.
type BuildItem = { id: string; status: string; startedAt: Date; buildNumber: string };
type RunItem = { id: string; buildId: string; buildNumber: string; status: string; startedAt: Date };

// Tolerates clock skew between the runner and the platform. Anything a step triggers starts well
// over a minute after its push (queueing, checkout, npm ci), and anything the previous step
// triggered started well before that step's run finished, so a small margin can't mix them up.
const CLOCK_SKEW_MS = 10_000;

// Enough to see everything one step starts; a step never builds or runs an Actor more than a few times.
const LIST_LIMIT = 50;

export class ApifyObserver {
    private readonly owner: ApifyClient;
    private readonly tester: ApifyClient;

    constructor({ ownerToken, testerToken }: { ownerToken: string; testerToken: string }) {
        this.owner = new ApifyClient({ token: ownerToken });
        this.tester = new ApifyClient({ token: testerToken });
    }

    /** Builds of the Actor started since `since`, newest first. Needs the owner's token. */
    buildsSince = async (actor: ActorKey, since: Date): Promise<BuildItem[]> => {
        const { items } = await this.owner.actor(ACTORS[actor]).builds().list({ desc: true, limit: LIST_LIMIT });
        return (items as unknown as BuildItem[]).filter((build) => isSince(build.startedAt, since));
    };

    /** Runs of the Actor the tester account started since `since`, i.e. the ones platform tests made. */
    testRunsSince = async (actor: ActorKey, since: Date): Promise<RunItem[]> => {
        const { items } = await this.tester.actor(ACTORS[actor]).runs().list({ desc: true, limit: LIST_LIMIT });
        return (items as unknown as RunItem[]).filter((run) => isSince(run.startedAt, since));
    };

    /** The build runs use when no build is given: the one behind the Actor's default tag. */
    defaultBuild = async (actor: ActorKey): Promise<{ tag: string; buildId: string; buildNumber: string }> => {
        const info = await this.owner.actor(ACTORS[actor]).get();
        if (!info) throw new Error(`${ACTORS[actor]} not found. Is E2E_APIFY_TOKEN the owner's token?`);
        const tag = info.defaultRunOptions.build;
        const tagged = info.taggedBuilds?.[tag];
        if (!tagged?.buildId || !tagged.buildNumber) throw new Error(`${ACTORS[actor]} has no build tagged "${tag}".`);
        return { tag, buildId: tagged.buildId, buildNumber: tagged.buildNumber };
    };
}

const isSince = (startedAt: Date | string, since: Date) =>
    new Date(startedAt).getTime() >= since.getTime() - CLOCK_SKEW_MS;
