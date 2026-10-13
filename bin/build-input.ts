import process from 'node:process';

import z, { prettifyError } from 'zod';

/**
 * What `build` reads from stdin: the Actors to build and, optionally, the branch to build them from. Only the Actor
 * names are read, the config file stays the source of truth for everything else about them. Other fields are
 * ignored, so a get-affected-actors document only needs its Actor list picked, e.g.
 * `jq '{ ref, actors: .functionallyChangedActors }'`.
 */
const buildInputSchema = z.object({
    ref: z.string().nullish(),
    actors: z.array(z.object({ actorFullName: z.string() })),
});

type BuildInput = z.infer<typeof buildInputSchema>;

const EXAMPLE = `e.g. echo '{"actors":[{"actorFullName":"owner/name"}]}' | apify-test-tools build`;

export const parseBuildInput = (raw: string): BuildInput => {
    // Empty input is an error, not "no Actors": it is what a failed command earlier in the pipe leaves behind
    if (!raw.trim()) {
        throw new Error(`Expected the Actors to build as JSON on stdin, got nothing (${EXAMPLE}).`);
    }
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (error) {
        throw new Error(`The input on stdin is not valid JSON: ${(error as Error).message}`);
    }
    const result = buildInputSchema.safeParse(json);
    if (!result.success) {
        throw new Error(
            `The input on stdin is not a list of Actors to build (${EXAMPLE}):\n${prettifyError(result.error)}`,
        );
    }
    return result.data;
};

export const readStdin = async (): Promise<string> => {
    // Nothing piped in: fail right away instead of waiting for someone to type
    if (process.stdin.isTTY) {
        throw new Error(`Expected the Actors to build as JSON on stdin (${EXAMPLE}).`);
    }
    let raw = '';
    for await (const chunk of process.stdin) {
        raw += chunk;
    }
    return raw;
};
