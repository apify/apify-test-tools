#!/usr/bin/env -S node --no-warnings

import process from 'node:process';

import yargs, { type Options } from 'yargs';
// eslint-disable-next-line import/extensions --- With .js, it cannot find types
import { hideBin } from 'yargs/helpers';

import { getAffectedActors } from './affected-actors.js';
import { buildActors, DEFAULT_VERSION_KEYWORD, deleteOldBuilds } from './build.js';
import { runBuildsFromLocal } from './build-from-local.js';
import { getChangedFiles, getCommits } from './git.js';
import { logger, logLevels } from './logger.js';
import { notifyOnChoices, notifyTestReport } from './notify.js';
import { writeJson } from './output.js';
import { runTests } from './run-tests.js';
import { notifyToSlack } from './slack.js';
import { parseBuildInput, parseReleaseChanges, parseTestBuilds, parseTestReport, readStdin } from './stdin-input.js';
import { readConfigFile } from './utils/config/load-config.js';

/**
 * Middlewares to be run before every command execution
 */
const middlewares = [(args: { logLevel: (typeof logLevels)[number] }) => logger.setLevel(args.logLevel)];

/*
 * Option groups shared across commands. Each is a plain object passed to `.options()`, so a command's
 * builder composes them by chaining (`y.options(gitRangeOptions).options(actorSelectionOptions)`)
 * instead of nesting wrapper functions. `as const` keeps literals like `demandOption: true` so yargs
 * can infer non-optional types; `satisfies` validates the shape without widening it.
 */

/** Commit range to inspect: everything on `source-branch` since it diverged from `target-branch`. */
const gitRangeOptions = {
    'target-branch': { type: 'string', demandOption: true },
    'source-branch': { type: 'string', demandOption: true },
    'base-commit': { type: 'string', demandOption: false },
} as const satisfies Record<string, Options>;

/**
 * Where to build the Actors from. Defaults to the `origin` remote, which is then checked against each
 * Actor's default version. Passing it explicitly skips that check (see assertRepoUrlMatchesDefaultVersion).
 */
const repoUrlOptions = {
    'repo-url': { type: 'string' },
} as const satisfies Record<string, Options>;

/**
 * Actor-selection flags, applied to every command that reads the actor config so a caller can
 * narrow the set it operates on (e.g. two-stage releases: `--ignore X`, then `--actors X`).
 * Kept separate from `gitRangeOptions` so the read-only git commands don't advertise flags they ignore.
 */
const actorSelectionOptions = {
    actors: { type: 'string', array: true, default: [] as string[] },
    ignore: { type: 'string', array: true, default: [] as string[] },
} as const satisfies Record<string, Options>;

/**
 * Commit range for get-affected-actors, which always ends at the checked-out HEAD. `base` and `since` combine:
 * `base` alone is a branch's own commits (a PR), `since` alone is everything after a commit (a release), both is
 * a branch after its last validated commit.
 */
const affectedRangeOptions = {
    base: { type: 'string', describe: 'Only count commits on HEAD that are not on this branch' },
    since: {
        type: 'string',
        describe: 'Only count commits after this one. Ignored with --base if it is not on the branch',
    },
    'test-files-glob': {
        type: 'string',
        describe: 'Glob (from the repo root) of test files that count as changes even when .dockerignore lists them',
    },
} as const satisfies Record<string, Options>;

/**
 * For commands that change something (builds, deletes, Slack posts). A dry run still does every read and check
 * the real run does, credentials included, and only skips the writes. So it needs the same tokens, though
 * read-only ones are enough. Read-only commands don't take it since they have nothing to skip.
 */
const dryRunOptions = {
    'dry-run': {
        type: 'boolean',
        default: false,
        describe: 'Do every read and check (tokens included) but change nothing; print what would be done',
    },
} as const satisfies Record<string, Options>;

/** Flags of `build`, which builds exactly the Actors it is given. */
const buildOptions = {
    'version-number': {
        type: 'string',
        demandOption: true,
        describe: `Version to build, like 0.1, or "${DEFAULT_VERSION_KEYWORD}" for each Actor's default version`,
        coerce: (value: string) => {
            if (value !== DEFAULT_VERSION_KEYWORD && !/^\d+\.\d+$/.test(value)) {
                throw new Error(
                    `--version-number must look like 0.1 or be "${DEFAULT_VERSION_KEYWORD}", got "${value}"`,
                );
            }
            return value;
        },
    },
} as const satisfies Record<string, Options>;

/** Where `notify-release` posts the release. */
const releaseSlackOptions = {
    'report-slack-channel': { type: 'string', describe: 'Channel for the full report: commits and changed files' },
    'release-slack-channel': { type: 'string', describe: 'Channel for the changelog additions only' },
} as const satisfies Record<string, Options>;

/** Flags of `test`, which runs the repository's vitest on the builds piped in from `build`. */
const testOptions = {
    all: {
        type: 'boolean',
        default: false,
        describe: "Test every Actor's default build instead of reading builds on stdin, as the scheduled tests do",
    },
    'max-concurrency': { type: 'number', default: 20, describe: 'Tests run at once in a file (vitest maxConcurrency)' },
    'max-workers': { type: 'number', default: 100, describe: 'Test files run at once (vitest maxWorkers)' },
    'vitest-output-file': { type: 'string', describe: "Also keep vitest's own JSON report there, e.g. to upload it" },
} as const satisfies Record<string, Options>;

/** Flags of `notify`. Each target is optional, so a caller picks where the report goes. */
const notifyOptions = {
    'slack-channel': {
        type: 'string',
        array: true,
        default: [] as string[],
        describe: 'Slack channel to post to, repeat it for more channels. Needs SLACK_TOKEN_TESTS_BOT',
    },
    on: { choices: notifyOnChoices, default: 'failure' as const, describe: 'Notify only when tests fail, or always' },
    title: { type: 'string', describe: 'What the message calls the run. Defaults to the GitHub workflow name' },
    'job-url': { type: 'string', describe: 'Where the message links to. Defaults to the GitHub Actions run' },
} as const satisfies Record<string, Options>;

/** Global flags, available to every command. */
const globalOptions = {
    'log-level': {
        type: 'string',
        choices: logLevels,
        default: 'info',
        describe: 'Minimum diagnostic level written to stderr; silent disables logging',
    },
} as const satisfies Record<string, Options>;

await yargs()
    .scriptName('public-actors-utils')
    // Everything after `--` is kept apart, so `test` can pass it to vitest as it is
    .parserConfiguration({ 'populate--': true })
    .options(globalOptions)
    .middleware(middlewares)
    .command(
        'get-commits',
        '',
        (y) => y.options(gitRangeOptions),
        async (args) => {
            const commits = await getCommits(args);
            writeJson(commits);
        },
    )
    .command(
        'get-latest-commit',
        '',
        (y) => y.options(gitRangeOptions),
        async (args) => {
            const commits = await getCommits(args);
            if (commits.length > 0) {
                writeJson(commits[commits.length - 1]);
            }
        },
    )
    .command(
        'get-changed-files',
        '',
        (y) => y.options(gitRangeOptions),
        async (args) => {
            const commits = await getCommits(args);
            const changedFiles = await getChangedFiles(commits);
            writeJson(changedFiles);
        },
    )
    .command(
        'get-actor-configs',
        '',
        (y) => y.options(actorSelectionOptions),
        async ({ actors, ignore }) => {
            const actorConfigs = await readConfigFile({ actors, ignore });
            writeJson(actorConfigs);
        },
    )
    .command(
        'get-affected-actors',
        'Find the Actors whose context changed in a commit range ending at the checked-out HEAD',
        (y) => y.options(affectedRangeOptions).options(actorSelectionOptions),
        async (args) => {
            writeJson(await getAffectedActors(args));
        },
    )
    .command(
        'test [filters..]',
        'Run the tests on the builds listed on stdin (the output of build), and print a report for notify',
        (y) =>
            y
                .positional('filters', {
                    type: 'string',
                    array: true,
                    default: ['test/platform'],
                    describe: 'Test files to run, as vitest filters. Pass more vitest flags after --',
                })
                .options(testOptions),
        async (args) => {
            const report = await runTests({
                filters: args.filters,
                builds: args.all ? null : parseTestBuilds(await readStdin()),
                maxConcurrency: args.maxConcurrency,
                maxWorkers: args.maxWorkers,
                vitestOutputFile: args.vitestOutputFile,
                vitestArgs: ((args['--'] as (string | number)[] | undefined) ?? []).map(String),
            });
            writeJson(report);
            // The report is printed either way, so `notify` later in the pipe still hears about the failure
            if (!report.success) process.exitCode = 1;
        },
    )
    .command(
        'notify',
        'Tell the configured targets how a test run went, from the report of test on stdin',
        (y) => y.options(notifyOptions).options(dryRunOptions),
        async (args) => {
            await notifyTestReport({
                report: parseTestReport(await readStdin()),
                on: args.on,
                slackChannels: args.slackChannel,
                title: args.title,
                jobUrl: args.jobUrl,
                dryRun: args.dryRun,
            });
        },
    )
    .command(
        'build',
        'Build the Actors listed on stdin, as {"actors": [{"actorFullName": ...}]}, from the checked-out branch',
        (y) => y.options(buildOptions).options(repoUrlOptions).options(dryRunOptions),
        async (args) => {
            const input = parseBuildInput(await readStdin());
            const names = input.actors.map(({ actorFullName }) => actorFullName);
            // An empty --actors selects every Actor, but an empty list here means there is nothing to build
            const actorConfigs = names.length > 0 ? await readConfigFile({ actors: names, ignore: [] }) : [];
            const builds = await buildActors({
                actorConfigs,
                versionNumber: args.versionNumber,
                repoUrl: args.repoUrl,
                dryRun: args.dryRun,
            });
            writeJson(builds);
        },
    )
    .command(
        'notify-release',
        'Announce a release on Slack, from the get-affected-actors output on stdin',
        (y) => y.options(releaseSlackOptions).options(repoUrlOptions).options(dryRunOptions),
        async (args) => {
            const { commits, changedFiles, changelog } = parseReleaseChanges(await readStdin());
            await notifyToSlack({
                commits,
                changedFiles,
                changelog,
                repoUrl: args.repoUrl,
                dryRun: args.dryRun,
                reportSlackChannel: args.reportSlackChannel,
                releaseSlackChannel: args.releaseSlackChannel,
            });
        },
    )
    .command(
        'build-from-local',
        '',
        (y) => y.options(actorSelectionOptions).options(dryRunOptions),
        async ({ actors, ignore, dryRun }) => {
            const actorConfigs = await readConfigFile({ actors, ignore });
            const builds = await runBuildsFromLocal({ actorConfigs, dryRun });
            writeJson(builds);
        },
    )
    .command(
        'delete-old-builds',
        '',
        (y) => y.options(actorSelectionOptions).options(dryRunOptions),
        async ({ actors, ignore, dryRun }) => {
            const actorConfigs = await readConfigFile({ actors, ignore });
            await deleteOldBuilds(actorConfigs, { dryRun });
        },
    )
    .strictCommands()
    .demandCommand(1, 'Command is required')
    .fail((msg, err, yargsInstance) => {
        // Errors thrown from a command handler (e.g. an unknown actor passed to --actors/--ignore,
        // or a missing config file) arrive here as `err`. A malformed selection must fail loudly
        // rather than silently operate on the wrong set of actors — print the message, no stack.
        if (err) {
            logger.error(`[ERROR]: ${err.message}`);
        } else {
            // Argument-parsing/validation failure — keep yargs' usage output.
            logger.error(yargsInstance.help());
            logger.error(`\n${msg}`);
        }
        process.exit(1);
    })
    .parse(hideBin(process.argv));
