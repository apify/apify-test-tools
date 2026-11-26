import z from 'zod';

import { ACTOR_FULL_NAME_REGEX, CONFIG_FILE_STRATEGY, defineStrategy } from './base.js';

// v1 renamed the build token's field so it reads apart from testTokenEnvVar. Without this, zod would drop an Actor's
// old tokenEnvVar without a word and build it with its group's token.
const renamedTokenEnvVar = z.never({ error: 'tokenEnvVar is renamed to buildTokenEnvVar' }).optional();

// The test token has no default, so each repo chooses who the tests run as and what that token may do
const requiredTokenEnvVar = (field: string) =>
    z
        .string({
            error: (issue) =>
                issue.input === undefined
                    ? `${field} is required. See the token permissions in the README: https://github.com/apify/apify-test-tools#token-permissions`
                    : undefined,
        })
        .min(1);

const schema = z.object({
    groups: z
        .record(
            z.string(),
            z.object({
                actors: z
                    .array(
                        z.object({
                            folder: z.string(),
                            actorFullName: z.string().regex(ACTOR_FULL_NAME_REGEX),
                            // these allow overrides from stuff set at the group level
                            buildTokenEnvVar: z.string().min(1).optional(),
                            tokenEnvVar: renamedTokenEnvVar,
                            testTokenEnvVar: z.string().min(1).optional(),
                            overrideActorContext: z.array(z.string()).optional(),
                        }),
                    )
                    .min(1),
                buildTokenEnvVar: requiredTokenEnvVar('buildTokenEnvVar'),
                tokenEnvVar: renamedTokenEnvVar,
                testTokenEnvVar: requiredTokenEnvVar('testTokenEnvVar'),
                overrideActorContext: z.array(z.string()).optional(),
            }),
        )
        .refine((data) => Object.keys(data).length > 0, 'Invalid input: At least one configuration group is required.'),
});

type GroupedConfig = z.infer<typeof schema>;

export const GROUPED_PARSER = defineStrategy(CONFIG_FILE_STRATEGY.GROUPED, schema, (body: GroupedConfig) => {
    const entries = Object.entries(body.groups);
    return entries.flatMap(([_folder, entry]) =>
        entry.actors.map((actor) => ({
            buildTokenEnvVar: entry.buildTokenEnvVar,
            testTokenEnvVar: entry.testTokenEnvVar,
            overrideActorContext: entry.overrideActorContext,
            // last so actor can override stuff from the group
            ...actor,
        })),
    );
});
