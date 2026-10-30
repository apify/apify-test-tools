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
    return validateStdinJson(json, schema, { expected, example });
};

const validateStdinJson = <T>(
    json: unknown,
    schema: ZodType<T>,
    { expected, example }: { expected: string; example: string },
) => {
    const result = schema.safeParse(json);
    if (!result.success) {
        throw new Error(`The input on stdin is not ${expected} (${example}):\n${prettifyError(result.error)}`);
    }
    return result.data;
};

/**
 * What `build` reads: the Actors to build. Only their names are read, the config file stays the source of truth
 * for everything else about them. Other fields are ignored, so a get-affected-actors document only needs its Actor
 * list picked, e.g. `jq '{ actors: .functionallyChangedActors }'`.
 */
const buildInputSchema = z.object({
    actors: z.array(z.object({ actorFullName: z.string() })),
});

export const parseBuildInput = (raw: string) =>
    parseStdinJson(raw, buildInputSchema, {
        expected: 'the Actors to build',
        example: `e.g. echo '{"actors":[{"actorFullName":"owner/name"}]}' | apify-test-tools build --version-number 0.1`,
    });

/**
 * What `test` reads: the builds to test, as `build` and `build-from-local` print them. A dry-run plan is an object
 * on purpose, so it is rejected here rather than tested as if it were built.
 */
const testBuildsSchema = z.array(
    z.object({ buildId: z.string(), actorRawId: z.string(), buildNumber: z.string(), actorFullName: z.string() }),
);

const isDryRunPlan = (raw: string) => {
    try {
        return (JSON.parse(raw) as { dryRun?: unknown } | null)?.dryRun === true;
    } catch {
        // Not JSON at all, parseStdinJson says so
        return false;
    }
};

export const parseTestBuilds = (raw: string) => {
    const example = 'e.g. ... | apify-test-tools build --version-number 0.99 | apify-test-tools test, or test --all';
    if (isDryRunPlan(raw)) {
        throw new Error(`The input on stdin is a dry-run plan, not builds, so there is nothing to test (${example}).`);
    }
    return parseStdinJson(raw, testBuildsSchema, { expected: 'the builds to test', example });
};

/** The report `test` prints, see TestReport. */
const testRunSchema = z.object({ actorId: z.string(), runId: z.string(), runLink: z.string() });
const testReportSchema = z.object({
    version: z.literal(1),
    success: z.boolean(),
    summary: z.object({ total: z.number(), passed: z.number(), failed: z.number(), skipped: z.number() }),
    tests: z.array(
        z.object({
            name: z.string(),
            file: z.string(),
            status: z.enum(['passed', 'failed', 'skipped']),
            durationMs: z.number().nullable(),
            failureMessages: z.array(z.string()),
            run: testRunSchema.nullable(),
        }),
    ),
    errors: z.array(z.string()),
});

/** The parts of a get-affected-actors document that describe what a release changed. Other fields are ignored. */
const releaseChangesSchema = z.object({
    commits: z.array(z.object({ sha: z.string(), author: z.string(), date: z.string(), message: z.string() })),
    changelog: z.string().nullable(),
});

export type ReleaseChanges = z.infer<typeof releaseChangesSchema>;

export type NotifyInput =
    | { kind: 'tests'; report: z.infer<typeof testReportSchema> }
    | { kind: 'release'; changes: ReleaseChanges };

/**
 * What `notify` reads: a test run, as `test` reports it, or a release, as `get-affected-actors` reports it. Told
 * apart by their fields, `tests` and `commits`, so either can be piped in as it is.
 */
export const parseNotifyInput = (raw: string): NotifyInput => {
    const example =
        'e.g. apify-test-tools test --all | apify-test-tools notify --slack-channel "#my-channel", ' +
        'or apify-test-tools get-affected-actors --since <sha> | apify-test-tools notify --slack-channel "#my-channel"';
    const expected = 'the output of test or get-affected-actors';
    const json = parseStdinJson(raw, z.unknown(), { expected, example });
    const has = (field: string) => typeof json === 'object' && json !== null && field in json;
    if (has('tests')) {
        const report = validateStdinJson(json, testReportSchema, { expected: 'the output of test', example });
        return { kind: 'tests', report };
    }
    if (has('commits')) {
        const changes = validateStdinJson(json, releaseChangesSchema, {
            expected: 'the output of get-affected-actors',
            example,
        });
        return { kind: 'release', changes };
    }
    throw new Error(`The input on stdin is not ${expected} (${example}).`);
};
