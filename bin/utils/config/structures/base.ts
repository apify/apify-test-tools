import { prettifyError, type ZodType } from 'zod';

import type { ExistingDir, RelativeDir } from '../../path/repo-relative.js';

// The lib checks the IDs tests name their Actors by with the same regex
export { ACTOR_FULL_NAME_REGEX } from '../../../../lib/consts.js';

// All fields must exist, even if their value can be undefined.
// This makes typescript enforce all configs to have resolution for EVERY field.
// So adding an extra field here creates TS errors in every config file that doesn't have it.
export interface ResolvedActorConfig {
    actorFullName: string;
    folder: string;
    tokenEnvVar: string;
    overrideActorContext: string[] | undefined;
}

export interface ValidatedActorConfig extends Omit<ResolvedActorConfig, 'folder' | 'overrideActorContext'> {
    folder: ExistingDir;
    overrideActorContext?: RelativeDir[];
}

export enum CONFIG_FILE_STRATEGY {
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
         * const strategy = defineStrategy(CONFIG_FILE_STRATEGY.GROUPED, schema, resolve);
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
