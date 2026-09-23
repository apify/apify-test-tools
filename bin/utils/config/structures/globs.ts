import { minimatch } from 'minimatch';
import z from 'zod';

import { ACTOR_FULL_NAME_REGEX, CONFIG_FILE_STRATEGY, defineStrategy, type ResolvedActorConfig } from './base.js';

const SETTING_KEYS = ['tokenEnvVar', 'overrideActorContext'] as const;

const schema = z.object({
    actors: z
        .array(
            z.object({
                folder: z.string(),
                actorFullName: z.string().regex(ACTOR_FULL_NAME_REGEX),
                tokenEnvVar: z.string().optional(),
                overrideActorContext: z.array(z.string()).optional(),
            }),
        )
        .min(1),
    configs: z
        .array(
            z.object({
                match: z
                    .object({
                        folderGlob: z.string().optional(),
                        actorFullNameGlob: z.string().optional(),
                    })
                    .refine((data) => Object.keys(data).length > 0, 'Invalid input: At least one glob is required.'),

                set: z
                    .object({
                        tokenEnvVar: z.string().optional(),
                        overrideActorContext: z.array(z.string()).optional(),
                    })
                    .refine((data) => Object.keys(data).length > 0, 'Invalid input: At least one setting is required.'),
            }),
        )
        .min(1),
});

type GlobsConfig = z.infer<typeof schema>;
type Actor = GlobsConfig['actors'][number];
type Match = GlobsConfig['configs'][number]['match'];

// folders are matched as written (no normalization) and dotfolders are skipped
const matches = (actor: Actor, { folderGlob, actorFullNameGlob }: Match) =>
    (folderGlob === undefined || minimatch(actor.folder, folderGlob)) &&
    (actorFullNameGlob === undefined || minimatch(actor.actorFullName, actorFullNameGlob));

export const GLOBS_PARSER = defineStrategy(CONFIG_FILE_STRATEGY.GLOBS, schema, (body: GlobsConfig) => {
    const errors: string[] = [];

    const resolved = body.actors.flatMap((actor): ResolvedActorConfig[] => {
        const result = { ...actor };
        // keep tracks of who set the key, the actor definition or the index of the config
        const owners = new Map<(typeof SETTING_KEYS)[number], 'actor' | number>();
        for (const key of SETTING_KEYS) {
            if (actor[key] !== undefined) owners.set(key, 'actor');
        }

        for (const [index, config] of body.configs.entries()) {
            if (!matches(actor, config.match)) continue;

            for (const key of SETTING_KEYS) {
                if (config.set[key] === undefined) continue;

                const owner = owners.get(key);
                if (owner === undefined) {
                    owners.set(key, index);
                    Object.assign(result, { [key]: config.set[key] });
                } else if (owner === 'actor') {
                    errors.push(
                        `Actor "${actor.actorFullName}": "${key}" is set on the actor and by configs[${index}].`,
                    );
                } else {
                    errors.push(
                        `Actor "${actor.actorFullName}": "${key}" is set by both configs[${owner}] and configs[${index}].`,
                    );
                }
            }
        }

        const { tokenEnvVar } = result;
        if (tokenEnvVar === undefined) {
            errors.push(
                `Actor "${actor.actorFullName}" has no tokenEnvVar: set it on the actor or through a matching config.`,
            );
            return [];
        }
        return [{ ...result, tokenEnvVar }];
    });

    if (errors.length > 0) {
        throw new Error(errors.join('\n'));
    }

    return resolved;
});
