import z from 'zod';

import { ACTOR_FULL_NAME_REGEX, CONFIG_FILE_STRATEGY, defineStrategy } from './base.js';

const schema = z.object({
    actors: z
        .array(
            z.object({
                folder: z.string(),
                actorFullName: z.string().regex(ACTOR_FULL_NAME_REGEX),
                tokenEnvVar: z.string(),
                overrideActorContext: z.array(z.string()).optional(),
            }),
        )
        .min(1),
});

type LegacyConfig = z.infer<typeof schema>;

export const LEGACY_PARSER = defineStrategy(CONFIG_FILE_STRATEGY.LEGACY, schema, (body: LegacyConfig) =>
    body.actors.map((x) => ({ overrideActorContext: undefined, ...x })),
);
