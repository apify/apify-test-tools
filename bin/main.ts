#!/usr/bin/env -S node --no-warnings

import process from 'node:process';

import yargs, { type Options } from 'yargs';
// eslint-disable-next-line import/extensions --- With .js, it cannot find types
import { hideBin } from 'yargs/helpers';

import { deleteOldBuilds, runBuilds } from './build.js';
import { runBuildsFromLocal } from './build-from-local.js';
import { getChangedActors } from './diff-changes.js';
import {
    getCommits,
    getCurrentBranch,
    getReleaseChanges,
    getRepoName,
    resolveReleaseBaseCommit,
    resolveRepoUrl,
} from './git.js';
import { resolveGitFileDiff } from './git-file-diff.js';
import { logger, logLevels } from './logger.js';
import { writeJson } from './output.js';
import { notifyToSlack } from './slack.js';
import { reportTestResults } from './test-report.js';
import type { Config } from './types.js';
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

/** Flags for commands that trigger Apify builds. */
const buildOptions = {
    'use-docker-cache': { type: 'boolean', default: false },
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

const resolveChangedActors = async (config: Config, { isLatest }: { isLatest: boolean }) => {
    const actorConfigs = await readConfigFile(config);
    const fileDiff = await resolveGitFileDiff(config);
    const cosmeticDiffRefs = {
        oldRef: fileDiff.mergeBaseSha,
        newRef: fileDiff.currentRef,
        ...(fileDiff.resolutionType === 'intersection' ? { baseCommit: fileDiff.baseCommit } : {}),
    };

    // The full check uses the net merge-base diff, optionally restricted to files changed since validation.
    return getChangedActors({
        filepathsChanged: fileDiff.changedFiles,
        actorConfigs,
        isLatest,
        diffRefs: cosmeticDiffRefs,
        testFilesGlob: config.testFilesGlob,
    });
};

await yargs()
    .scriptName('public-actors-utils')
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
            const fileDiff = await resolveGitFileDiff(args);
            writeJson(fileDiff.changedFiles);
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
        '',
        (y) => y.options(gitRangeOptions).options(actorSelectionOptions),
        async (config) => {
            const actorsChanged = await resolveChangedActors(config, { isLatest: false });
            writeJson(actorsChanged);
        },
    )
    .command(
        'report-tests',
        '',
        (y) =>
            y
                .options(dryRunOptions)
                .option('report-file', { type: 'string', demandOption: true })
                .option('report-slack-channel', { type: 'string' })
                .option('job-url', { type: 'string' })
                .option('workflow-name', { type: 'string' }),
        async (args) => {
            await reportTestResults(args);
        },
    )
    .command(
        'build',
        '',
        (y) =>
            y
                .options(gitRangeOptions)
                .options(actorSelectionOptions)
                .options(buildOptions)
                .options(repoUrlOptions)
                .options(dryRunOptions)
                .option('test-files-glob', { type: 'string' }),
        async (config) => {
            const actorsChanged = await resolveChangedActors(config, { isLatest: false });
            const builds = await runBuilds({
                ...(await resolveRepoUrl(config.repoUrl)),
                actorConfigs: actorsChanged,
                branch: config.sourceBranch.replace('origin/', ''),
                dryRun: config.dryRun,
                useDockerCache: config.useDockerCache,
            });
            writeJson(builds);
        },
    )
    .command(
        'release',
        '',
        (y) =>
            y
                .options(actorSelectionOptions)
                .options(buildOptions)
                .options(repoUrlOptions)
                .options(dryRunOptions)
                // The last commit that is already released, everything after it up to HEAD gets released.
                // Required, see the README section "Releasing Actors" for how to set it for each merge strategy.
                .option('base-commit', { type: 'string', demandOption: true })
                .option('report-slack-channel', { type: 'string' })
                .option('release-slack-channel', { type: 'string' }),
        async (args) => {
            const baseSha = await resolveReleaseBaseCommit(args.baseCommit);
            const branch = await getCurrentBranch();
            const changes = await getReleaseChanges(baseSha);
            if (!changes) {
                logger.info(`HEAD is the base commit ${baseSha}, there is nothing new to release`);
                return;
            }
            const { commits, changedFiles, changelog } = changes;
            const { repoUrl, shouldVerifyRepoUrl } = await resolveRepoUrl(args.repoUrl);

            const isLatest = true;
            const actorConfigs = await readConfigFile(args);
            const actorsChanged = await getChangedActors({
                filepathsChanged: changedFiles,
                actorConfigs,
                isLatest,
                diffRefs: { oldRef: baseSha, newRef: 'HEAD' },
            });
            const { dryRun, reportSlackChannel, releaseSlackChannel } = args;
            const builds = await runBuilds({
                isLatest,
                repoUrl,
                shouldVerifyRepoUrl,
                actorConfigs: actorsChanged,
                branch,
                dryRun,
                useDockerCache: args.useDockerCache,
            });
            logger.info(JSON.stringify(builds));

            await notifyToSlack({
                changedFiles,
                commits,
                changelog,
                repository: getRepoName(repoUrl),
                dryRun,
                // The newest commit, same as the pushed head commit
                author: commits[commits.length - 1].author,
                reportSlackChannel,
                releaseSlackChannel,
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
