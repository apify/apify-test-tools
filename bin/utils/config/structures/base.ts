import { prettifyError, z, type ZodType } from 'zod';

import { ACTOR_NAME, USERNAME } from '@apify/consts';

import type { ActorEnvVarConfig } from '../../../types.js';
import type { ExistingDir, RelativeDir } from '../../path/repo-relative.js';

function stripRegexAnchor(regex: string): string {
    return regex.replace(/^\^/, '').replace(/\$$/, '');
}

export const ACTOR_FULL_NAME_REGEX = new RegExp(
    `^${stripRegexAnchor(USERNAME.REGEX.source)}/${stripRegexAnchor(ACTOR_NAME.REGEX.source)}$`,
    USERNAME.REGEX.flags + ACTOR_NAME.REGEX.flags,
);

/** Validates declared source names and flags without reading environment values. */
export const ActorEnvVarsSchema = z
    .record(
        z.string().regex(/\S/, 'Environment variable name must not be blank.'),
        z.object({
            fromEnv: z.string().regex(/\S/, 'fromEnv must not be blank.'),
            isSecret: z.boolean(),
            isShared: z.boolean().optional(),
        }),
    )
    .optional();

// Fields with group defaults must exist, even if their value can be undefined,
// so TypeScript enforces their resolution in every configuration strategy.
export interface ResolvedActorConfig {
    actorFullName: string;
    folder: string;
    tokenEnvVar: string;
    overrideActorContext: string[] | undefined;
    envVars?: Record<string, ActorEnvVarConfig>;
}

export interface ValidatedActorConfig extends Omit<ResolvedActorConfig, 'folder' | 'overrideActorContext'> {
    folder: ExistingDir;
    overrideActorContext?: RelativeDir[];
}

export enum CONFIG_FILE_STRATEGY {
    LEGACY = 'legacy',
    GROUPED = 'grouped',
}

export type StrategyParser = {
    mode: CONFIG_FILE_STRATEGY;
    parse: (body: Record<string, unknown>) => ResolvedActorConfig[];
};

export function defineStrategy<T extends Record<string, unknown>, Mode extends CONFIG_FILE_STRATEGY>(
    // mode is transparent so it can be validated with & { mode: Mode }
    mode: Mode,
    schema: ZodType<T>,
    resolve: (body: T) => ResolvedActorConfig[],
) {
    return {
        mode,
        /**
         *
         * @param body raw config file to be read
         * @returns ResolvedActorConfig[] if the config file is valid, otherwise throws an error with a description of the issues.
         * @throws Error if the config file is invalid.
         * @example
         * ```ts
         * const strategy = defineStrategy(CONFIG_FILE_STRATEGY.LEGACY, schema, resolve);
         * const resolvedActors = strategy.parse(configFileContents);
         * ```
         *
         * This function is used to parse the config file according to the strategy defined by the user.
         * It uses the schema defined in the strategy to validate the config file and resolve it into a list of ResolvedActorConfig.
         * If the config file is invalid, it throws an error with a description of the issues.
         */
        parse: (body: Record<string, unknown>) => {
            const parsed = schema.safeParse(body);
            if (parsed.success) {
                return resolve(parsed.data);
            }
            throw new Error(prettifyError(parsed.error));
        },
    };
}
