#!/usr/bin/env -S node --no-warnings

import process from 'node:process';

import yargs, { type Options } from 'yargs';
// eslint-disable-next-line import/extensions --- With .js, it cannot find types
import { hideBin } from 'yargs/helpers';

import { deleteOldBuilds, runBuilds } from './build.js';
import { runBuildsFromLocal } from './build-from-local.js';
import { getChangedActors } from './diff-changes.js';
import {
    getBranchOnlyChangedFiles,
    getChangedFiles,
    getCommits,
    getCurrentBranch,
    getReleaseChanges,
    getRepoName,
    hasMergeFromTarget,
    resolveReleaseBaseCommit,
    resolveRepoUrl,
} from './git.js';
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
    'dry-run': { type: 'boolean', default: false },
} as const satisfies Record<string, Options>;

const resolveChangedActors = async (config: Config, { isLatest }: { isLatest: boolean }) => {
    const actorConfigs = await readConfigFile(config);

    // This is an optimization for the common case where a branch only has cosmetic changes but had to smerge in
    // functional changes from master (being up-to-date is a CI requirement). Master is already validated, and
    // since the branch has no functional changes of its own, there is nothing new to validate.
    // Exception: if the branch has any functional changes alongside the merge, we must re-test — even
    // individually validated changes can have novel interactions when combined.
    if (hasMergeFromTarget(config.sourceBranch, config.targetBranch)) {
        logger.info(
            '[MERGE-FROM-TARGET-OPTIMIZATION]: There is merge from target branch, checking if there are no functional changes in our own branch. If so, we can skip tests',
        );
        const branchOnlyFiles = getBranchOnlyChangedFiles(config.sourceBranch, config.targetBranch);
        // Omit baseCommit to get full branch history. Validated functional commits can still interact with merged ones
        const allBranchCommits = getCommits({ ...config, baseCommit: undefined });
        const branchOnlyActorsChanged = getChangedActors({
            filepathsChanged: branchOnlyFiles,
            actorConfigs,
            commits: allBranchCommits,
        });
        if (branchOnlyActorsChanged.length === 0) {
            logger.info('[MERGE-FROM-TARGET-OPTIMIZATION]: Branch itself has no functional changes, skipping tests');
            return [];
        }
        logger.info(
            `[MERGE-FROM-TARGET-OPTIMIZATION]: Branch has ${branchOnlyActorsChanged.length} functional changes, cannot optimize, we continue with full check`,
        );
    }

    // If the optimization doesn't apply, we check all branch commits including merges for full coverage. We don't reuse the merge optimization results because here we can apply baseCommit and check merge commits (they might be functional or just cosmetic)
    const commits = getCommits(config);
    const changedFiles = await getChangedFiles(commits);
    return getChangedActors({ filepathsChanged: changedFiles, actorConfigs, isLatest, commits });
};

await yargs()
    .scriptName('public-actors-utils')
    .options(globalOptions)
    .middleware(middlewares)
    .command(
        'get-commits',
        '',
        (y) => y.options(gitRangeOptions),
        (args) => {
            const commits = getCommits(args);
            writeJson(commits);
        },
    )
    .command(
        'get-latest-commit',
        '',
        (y) => y.options(gitRangeOptions),
        (args) => {
            const commits = getCommits(args);
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
            const commits = getCommits(args);
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
        (y) => y.options(gitRangeOptions).options(actorSelectionOptions).options(buildOptions).options(repoUrlOptions),
        async (config) => {
            const actorsChanged = await resolveChangedActors(config, { isLatest: false });
            const builds = await runBuilds({
                ...resolveRepoUrl(config.repoUrl),
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
                // The last commit that is already released, everything after it up to HEAD gets released.
                // Required, see the README section "Releasing Actors" for how to set it for each merge strategy.
                .option('base-commit', { type: 'string', demandOption: true })
                .option('report-slack-channel', { type: 'string' })
                .option('release-slack-channel', { type: 'string' }),
        async (args) => {
            const baseSha = resolveReleaseBaseCommit(args.baseCommit);
            const branch = getCurrentBranch();
            const changes = getReleaseChanges(baseSha);
            if (!changes) {
                logger.info(`HEAD is the base commit ${baseSha}, there is nothing new to release`);
                return;
            }
            const { commits, changedFiles, changelog } = changes;
            const { repoUrl, shouldVerifyRepoUrl } = resolveRepoUrl(args.repoUrl);

            const isLatest = true;
            const actorConfigs = await readConfigFile(args);
            const actorsChanged = getChangedActors({
                filepathsChanged: changedFiles,
                actorConfigs,
                isLatest,
                commits,
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
        (y) => y.options(actorSelectionOptions),
        async ({ actors, ignore, dryRun }) => {
            const actorConfigs = await readConfigFile({ actors, ignore });
            const builds = await runBuildsFromLocal({ actorConfigs, dryRun });
            writeJson(builds);
        },
    )
    .command(
        'delete-old-builds',
        '',
        (y) => y.options(actorSelectionOptions),
        async ({ actors, ignore }) => {
            const actorConfigs = await readConfigFile({ actors, ignore });
            await deleteOldBuilds(actorConfigs);
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
