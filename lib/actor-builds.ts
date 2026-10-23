import type { ActorBuild } from './types.js';

const ACTOR_BUILDS_ENV = 'ACTOR_BUILDS';

/**
 * The builds the `build` command made for this CI run, looked up by an Actor's full name or raw ID.
 * An empty registry means nothing was built, e.g. in scheduled runs against the deployed Actors.
 */
export class ActorBuilds {
    private readonly byActor = new Map<string, ActorBuild>();

    constructor(builds: ActorBuild[]) {
        for (const build of builds) {
            this.byActor.set(build.actorFullName, build);
            this.byActor.set(build.actorRawId, build);
        }
    }

    /** Parses the JSON array the CLI passes in `ACTOR_BUILDS`. Unset or empty means no builds. */
    static fromEnv(env: Record<string, string | undefined> = process.env): ActorBuilds {
        const raw = env[ACTOR_BUILDS_ENV];
        if (!raw) return new ActorBuilds([]);
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                throw new Error(`it should contain a JSON array, got ${typeof parsed}`);
            }
            return new ActorBuilds(parsed as ActorBuild[]);
        } catch (err) {
            throw new Error(`Failed to parse ${ACTOR_BUILDS_ENV} env variable: ${err}`);
        }
    }

    get(actorId: string): ActorBuild | undefined {
        return this.byActor.get(actorId);
    }

    has(actorId: string): boolean {
        return this.byActor.has(actorId);
    }
}
