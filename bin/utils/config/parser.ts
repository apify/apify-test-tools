import z from 'zod';

import { CONFIG_FILE_STRATEGY, type ResolvedActorConfig, type StrategyParser } from './structures/base.js';
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

/**
 * Normalizes the paths the user wrote and checks the cross-entry invariants a per-entry schema
 * cannot: that no two actors claim the same folder once normalized, nor the same actor on the
 * platform. Collects every violation before throwing, so one run reports all of them rather than
 * only the first.
 *
 * @returns the actors it vouched for, with their paths normalized.
 * @throws Error listing every problem found.
 */
function verifyConfiguration(body: ResolvedActorConfig[]): ResolvedActorConfig[] {
    const seenFolders = new Set<string>();
    const seenActorFullNames = new Set<string>();
    const errors: string[] = [];

    const normalized = body.map((entry) => ({
        ...entry,
        folder: normalizeFolder(entry.folder),
        overrideActorContext: entry.overrideActorContext?.map(stripTrailingSlash),
    }));

    for (const [index, entry] of normalized.entries()) {
        // TODO: drop folder uniqueness (this requires several changes on other places)
        if (seenFolders.has(entry.folder)) {
            errors.push(`Duplicate folder "${body[index].folder}". Each actor must have a unique folder.`);
        } else {
            seenFolders.add(entry.folder);
        }

        if (seenActorFullNames.has(entry.actorFullName)) {
            errors.push(`Duplicate actor "${entry.actorFullName}". Each entry must point at a different actor.`);
        } else {
            seenActorFullNames.add(entry.actorFullName);
        }
    }

    if (errors.length > 0) {
        throw new Error(errors.join('\n'));
    }

    return normalized;
}

// eslint-disable-next-line no-underscore-dangle
export const _privates = {
    selectStrategy,
    verifyConfiguration,
};

export function parseConfigFile(body: Record<string, unknown>): ResolvedActorConfig[] {
    const strategy = selectStrategy(body);

    const resolved = strategy.parse(body);
    const validated = verifyConfiguration(resolved);
    return validated;
}
