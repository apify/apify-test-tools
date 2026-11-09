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
 * What `build` reads: the Actors to build. Their names and an optional existing `build` to reuse are read, the config
 * file stays the source of truth for everything else about them. Other fields are ignored, so a get-affected-actors
 * document only needs its Actor lists picked, e.g.
 * `jq '{ actors: (.functionallyChangedActors + .testChangedActors) }'`.
 */
const existingBuildSchema = z.union([
    z.literal('default'),
    z.object({ buildId: z.string(), actorRawId: z.string(), buildNumber: z.string() }),
]);

const buildInputSchema = z.object({
    actors: z.array(
        z.object({
            actorFullName: z.string(),
            // From testChangedActors: an existing build that runs the tests instead of a new one
            build: existingBuildSchema.optional(),
            // From select-changed-tests: only these test files run for the Actor. Passed through to the output
            testFiles: z.array(z.string()).optional(),
        }),
    ),
});

export type BuildTarget = z.infer<typeof buildInputSchema>['actors'][number];

export const parseBuildInput = (raw: string) =>
    parseStdinJson(raw, buildInputSchema, {
        expected: 'the Actors to build',
        example: `e.g. echo '{"actors":[{"actorFullName":"owner/name"}]}' | apify-test-tools build --version-number 0.1`,
    });

/**
 * What `select-changed-tests` reads: the output of `get-affected-actors --base`. It prints the same document back, so
 * the other fields, also those of each Actor, are kept.
 */
const selectChangedTestsInputSchema = z.looseObject({
    head: z.string(),
    testChangesSince: z.string(),
    testChangedActors: z.array(z.looseObject({ actorFullName: z.string() })),
});

export type SelectChangedTestsInput = z.infer<typeof selectChangedTestsInputSchema>;

export const parseSelectChangedTestsInput = (raw: string): SelectChangedTestsInput =>
    parseStdinJson(raw, selectChangedTestsInputSchema, {
        expected: 'the output of get-affected-actors',
        example:
            'e.g. apify-test-tools get-affected-actors --base origin/master | apify-test-tools select-changed-tests',
    });

/**
 * What `test` reads: the Actors to test, each with the build to test or, without one, its default build. The builds
 * `build` and `build-from-local` print fit, and so does `get-actor-configs`, whose other fields are ignored. An Actor
 * needs its full name or its raw ID, `test` looks up the other. A dry-run plan is an object on purpose, so it is
 * rejected here rather than tested as if it were built.
 */
const testTargetsSchema = z.array(
    z
        .object({
            actorFullName: z.string().optional(),
            buildId: z.string().optional(),
            actorRawId: z.string().optional(),
            buildNumber: z.string().optional(),
            // Only the tests of the Actor in these files run, as repo-root-relative paths. Without it, all of them
            testFiles: z.array(z.string()).optional(),
        })
        .refine(({ actorFullName, actorRawId }) => !!actorFullName || !!actorRawId, {
            message: 'An Actor needs actorFullName or actorRawId',
        }),
);

export type TestTarget = z.infer<typeof testTargetsSchema>[number];

const isDryRunPlan = (raw: string) => {
    try {
        return (JSON.parse(raw) as { dryRun?: unknown } | null)?.dryRun === true;
    } catch {
        // Not JSON at all, parseStdinJson says so
        return false;
    }
};

export const parseTestTargets = (raw: string) => {
    const example =
        'e.g. ... | apify-test-tools build --version-number 0.99 | apify-test-tools test, ' +
        "or apify-test-tools get-actor-configs | apify-test-tools test for every Actor's default build";
    if (isDryRunPlan(raw)) {
        throw new Error(`The input on stdin is a dry-run plan, not builds, so there is nothing to test (${example}).`);
    }
    return parseStdinJson(raw, testTargetsSchema, { expected: 'the Actors to test', example });
};

/** The report `test` prints, see TestReport. */
const testRunSchema = z.object({ actorId: z.string(), runId: z.string(), runLink: z.string() });
const testReportSchema = z.object({
    kind: z.literal('test-report'),
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
 * What `notify` reads: a test run, as `test` reports it, or a release, as `get-affected-actors` reports it. The test
 * report says so in its `kind`, a release is told by its `commits`, so either can be piped in as it is.
 */
export const parseNotifyInput = (raw: string): NotifyInput => {
    const example =
        'e.g. ... | apify-test-tools test | apify-test-tools notify --slack-channel "#my-channel", ' +
        'or apify-test-tools get-affected-actors --since <sha> | apify-test-tools notify --slack-channel "#my-channel"';
    const expected = 'the output of test or get-affected-actors';
    const json = parseStdinJson(raw, z.looseObject({}), { expected, example });
    if (json.kind === 'test-report') {
        const report = validateStdinJson(json, testReportSchema, { expected: 'the output of test', example });
        return { kind: 'tests', report };
    }
    if ('commits' in json) {
        const changes = validateStdinJson(json, releaseChangesSchema, {
            expected: 'the output of get-affected-actors',
            example,
        });
        return { kind: 'release', changes };
    }
    throw new Error(`The input on stdin is not ${expected} (${example}).`);
};
