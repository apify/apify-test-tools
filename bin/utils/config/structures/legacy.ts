import z from 'zod';

import { CONFIG_FILE_STRATEGY, defineStrategy } from './base.js';

const schema = z.object({
    actors: z
        .array(
            z.object({
                folder: z.string(),
                actorFullName: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
                tokenEnvVar: z.string(),
                overrideActorContext: z.array(z.string()).optional(),
            }),
        )
        .min(1),
});

type LegacyConfig = z.infer<typeof schema>;

export const LEGACY_PARSER = defineStrategy(CONFIG_FILE_STRATEGY.LEGACY, schema, (body: LegacyConfig) => body.actors);
