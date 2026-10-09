import z from 'zod';

import { ExistingDirSchema, RelativeDirSchema } from '../path/schema.js';
import {
    ActorEnvVarsSchema,
    CONFIG_FILE_STRATEGY,
    type ResolvedActorConfig,
    type StrategyParser,
    type ValidatedActorConfig,
} from './structures/base.js';
import { GROUPED_PARSER } from './structures/grouped.js';
import { LEGACY_PARSER } from './structures/legacy.js';

const CONFIG_FILE_STRATEGIES: {
    // instead of Record, we do this to ensure that the modes match
    [key in CONFIG_FILE_STRATEGY]: StrategyParser & { mode: key };
} = {
    [CONFIG_FILE_STRATEGY.LEGACY]: LEGACY_PARSER,
    [CONFIG_FILE_STRATEGY.GROUPED]: GROUPED_PARSER,
} as const;

const ModeSelectionSchema = z.object({ mode: z.enum(CONFIG_FILE_STRATEGY).default(CONFIG_FILE_STRATEGY.LEGACY) });

function selectStrategy(mode: unknown): StrategyParser {
    const parsed = ModeSelectionSchema.safeParse(mode);
    if (!parsed.success) {
        throw new Error(z.prettifyError(parsed.error));
    }

    return CONFIG_FILE_STRATEGIES[parsed.data.mode];
}

// Strips a trailing slash so config-declared paths ("actors/shopify/" vs "actors/shopify") compare equal.
const stripTrailingSlash = (pathValue: string): string => pathValue.replace(/\/+$/, '');

// The repo root may be written as ".", "./", "/" or ""; everything downstream spells it "".
const normalizeFolder = (folder: string): string => {
    const stripped = stripTrailingSlash(folder);
    return stripped === '.' ? '' : stripped;
};

const ValidatedConfigSchema = z.array(
    z.object({
        actorFullName: z.string(),
        folder: ExistingDirSchema,
        tokenEnvVar: z.string(),
        overrideActorContext: z.array(RelativeDirSchema).optional(),
        envVars: ActorEnvVarsSchema,
    }),
);

/** Normalize and validate paths, then check collisions using their final spelling. */
function verifyConfiguration(body: ResolvedActorConfig[]): ValidatedActorConfig[] {
    const normalized = body.map((entry) => ({
        ...entry,
        folder: normalizeFolder(entry.folder),
        overrideActorContext: entry.overrideActorContext?.map(stripTrailingSlash),
    }));
    const parsed = ValidatedConfigSchema.safeParse(normalized);
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));

    const seenFolders = new Set<string>();
    const seenActorFullNames = new Set<string>();
    const errors: string[] = [];
    for (const [index, entry] of parsed.data.entries()) {
        // TODO: drop folder uniqueness (this requires several changes on other places)
        if (seenFolders.has(entry.folder.path)) {
            errors.push(`Duplicate folder "${body[index].folder}". Each actor must have a unique folder.`);
        } else {
            seenFolders.add(entry.folder.path);
        }

        if (seenActorFullNames.has(entry.actorFullName)) {
            errors.push(`Duplicate actor "${entry.actorFullName}". Each entry must point at a different actor.`);
        } else {
            seenActorFullNames.add(entry.actorFullName);
        }
    }

    if (errors.length > 0) throw new Error(errors.join('\n'));
    return parsed.data;
}

// eslint-disable-next-line no-underscore-dangle
export const _privates = {
    selectStrategy,
    verifyConfiguration,
};

export function parseConfigFile(body: Record<string, unknown>): ValidatedActorConfig[] {
    const { mode, ...rest } = body;
    const strategy = selectStrategy({ mode });

    const resolved = strategy.parse(rest);
    return verifyConfiguration(resolved);
}
