import process from 'node:process';

import z, { prettifyError, type ZodType } from 'zod';

export const readStdin = async (): Promise<string> => {
    // Nothing piped in: fail right away instead of waiting for someone to type
    if (process.stdin.isTTY) {
        throw new Error('Expected JSON on stdin, but nothing was piped in.');
    }
    let raw = '';
    for await (const chunk of process.stdin) {
        raw += chunk;
    }
    return raw;
};

const parseStdinJson = <T>(
    raw: string,
    schema: ZodType<T>,
    { expected, example }: { expected: string; example: string },
) => {
    // Empty input is an error, not "nothing to do": it is what a failed command earlier in the pipe leaves behind
    if (!raw.trim()) {
        throw new Error(`Expected ${expected} as JSON on stdin, got nothing (${example}).`);
    }
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (error) {
        throw new Error(`The input on stdin is not valid JSON: ${(error as Error).message}`);
    }
    const result = schema.safeParse(json);
    if (!result.success) {
        throw new Error(`The input on stdin is not ${expected} (${example}):\n${prettifyError(result.error)}`);
    }
    return result.data;
};

/**
 * What `build` reads: the Actors to build and, optionally, the branch to build them from. Only the Actor names are
 * read, the config file stays the source of truth for everything else about them. Other fields are ignored, so a
 * get-affected-actors document only needs its Actor list picked, e.g. `jq '{ actors: .functionallyChangedActors }'`.
 */
const buildInputSchema = z.object({
    ref: z.string().nullish(),
    actors: z.array(z.object({ actorFullName: z.string() })),
});

export const parseBuildInput = (raw: string) =>
    parseStdinJson(raw, buildInputSchema, {
        expected: 'the Actors to build',
        example: `e.g. echo '{"actors":[{"actorFullName":"owner/name"}]}' | apify-test-tools build --version-number 0.1`,
    });

/** What `notify-release` reads: the parts of a get-affected-actors document that describe what changed. */
const releaseChangesSchema = z.object({
    commits: z.array(z.object({ sha: z.string(), author: z.string(), date: z.string(), message: z.string() })),
    changedFiles: z.array(z.string()),
    changelog: z.string().nullable(),
});

export const parseReleaseChanges = (raw: string) =>
    parseStdinJson(raw, releaseChangesSchema, {
        expected: 'the output of get-affected-actors',
        example: 'e.g. apify-test-tools get-affected-actors --since <sha> | apify-test-tools notify-release',
    });
