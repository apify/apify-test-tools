import z from 'zod';

import { ACTOR_FULL_NAME_REGEX, CONFIG_FILE_STRATEGY, defineStrategy } from './base.js';

const schema = z
    .record(
        z.string(),
        z.object({
            actors: z
                .array(
                    z.object({
                        folder: z.string(),
                        actorFullName: z.string().regex(ACTOR_FULL_NAME_REGEX),
                        // these allow overrides from stuff set at the group level
                        tokenEnvVar: z.string().optional(),
                        overrideActorContext: z.array(z.string()).optional(),
                    }),
                )
                .min(1),
            tokenEnvVar: z.string(),
            overrideActorContext: z.array(z.string()).optional(),
        }),
    )
    .refine((data) => Object.keys(data).length > 0, 'Invalid input: At least one configuration group is required.');

type GroupedConfig = z.infer<typeof schema>;

export const GROUPED_PARSER = defineStrategy(CONFIG_FILE_STRATEGY.GROUPED, schema, (body: GroupedConfig) => {
    const entries = Object.entries(body);
    return entries.flatMap(([_folder, entry]) =>
        entry.actors.map((actor) => ({
            tokenEnvVar: entry.tokenEnvVar,
            overrideActorContext: entry.overrideActorContext,
            // last so actor can override stuff from the group
            ...actor,
        })),
    );
});
