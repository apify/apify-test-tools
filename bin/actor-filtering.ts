import type { ActorConfig } from './types.js';

/**
 * Restricts a set of actors to those selected via `--actors` and not excluded via `--ignore`.
 * Both filters match on `actorFullName` (`owner/name`). `--actors` is applied first (empty means
 * "all"), then `--ignore` removes from the result. A name that doesn't exist in the config throws —
 * a malformed selection must never silently build/release/delete the wrong set. The caller is
 * responsible for turning that into a non-zero exit.
 */
export function selectActors({ actors, ignore }: { actors: string[]; ignore: string[] }, actorConfigs: ActorConfig[]) {
    const fullNames = actorConfigs.map((actor) => actor.actorFullName);
    const missing = [...actors, ...ignore].filter((name) => !fullNames.includes(name));
    if (missing.length > 0) {
        throw new Error(`The following actors from the filter config do not exist: ${missing.join(', ')}`);
    }

    const afterOnly = actors.length
        ? actorConfigs.filter((actor) => actors.includes(actor.actorFullName))
        : actorConfigs;
    return afterOnly.filter((actor) => !ignore.includes(actor.actorFullName));
}
