#!/usr/bin/env node

import process from 'node:process';

import yargs, { type Argv } from 'yargs';
// eslint-disable-next-line import/extensions --- With .js, it cannot find types
import { hideBin } from 'yargs/helpers';

import { selectActors } from './actor-filtering.js';
import { deleteOldBuilds, runBuilds } from './build.js';
import { runBuildsFromLocal } from './build-from-local.js';
import { getChangedActors } from './diff-changes.js';
import { getBranchOnlyChangedFiles, getChangedFiles, getCommits, hasMergeFromTarget } from './git.js';
import { getPushData } from './github.js';
import { notifyToSlack } from './slack.js';
import { reportTestResults } from './test-report.js';
import type { Config } from './types.js';
import { readConfigFile, setCwd, spawnCommandInGhWorkspace } from './utils.js';

/**
 * Middlewares to be run before every command execution
 */
const middlewares = [setCwd];

export const buildOptions = <T>(y: Argv<T>) => {
    return y
        .option('target-branch', {
            type: 'string',
            demandOption: true,
        })
        .option('source-branch', {
            type: 'string',
            demandOption: true,
        })
        .option('use-docker-cache', {
            type: 'boolean',
            default: false,
        })
        .option('base-commit', {
            type: 'string',
            demandOption: false,
        });
};

/**
 * Actor-selection flags, applied to every command that reads the actor config so a caller can
 * narrow the set it operates on (e.g. two-stage releases: `--ignore X`, then `--actors X`).
 * Kept separate from `buildOptions` so the read-only git commands don't advertise flags they ignore.
 */
export const actorSelectionOptions = <T>(y: Argv<T>) => {
    return y
        .option('actors', {
            type: 'string',
            array: true,
            default: [] as string[],
        })
        .option('ignore', {
            type: 'string',
            array: true,
            default: [] as string[],
        });
};

const resolveChangedActors = async (config: Config, { isLatest }: { isLatest: boolean }) => {
    const originalActorConfigs = await readConfigFile();
    const actorConfigs = selectActors(config, originalActorConfigs);

    // This is an optimization for the common case where a branch only has cosmetic changes but had to smerge in
    // functional changes from master (being up-to-date is a CI requirement). Master is already validated, and
    // since the branch has no functional changes of its own, there is nothing new to validate.
    // Exception: if the branch has any functional changes alongside the merge, we must re-test — even
    // individually validated changes can have novel interactions when combined.
    if (hasMergeFromTarget(config.sourceBranch, config.targetBranch)) {
        console.error(
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
            console.error('[MERGE-FROM-TARGET-OPTIMIZATION]: Branch itself has no functional changes, skipping tests');
            return [];
        }
        console.error(
            `[MERGE-FROM-TARGET-OPTIMIZATION]: Branch has ${branchOnlyActorsChanged.length} functional changes, cannot optimize, we continue with full check`,
        );
    }

    // If the optimization doesn't apply, we check all branch commits including merges for full coverage. We don't reuse the merge optimization results because here we can apply baseCommit and check merge commits (they might be functional or just cosmetic)
    const commits = getCommits(config);
    const changedFiles = getChangedFiles(commits);
    return getChangedActors({ filepathsChanged: changedFiles, actorConfigs, isLatest, commits });
};

await yargs()
    .scriptName('public-actors-utils')
    .option('dry-run', {
        type: 'boolean',
        default: false,
    })
    .option('workspace', {
        type: 'string',
    })
    .middleware(middlewares)
    .command('get-commits', '', buildOptions, (args) => {
        const commits = getCommits(args);
        console.log(JSON.stringify(commits));
    })
    .command('get-latest-commit', '', buildOptions, (args) => {
        const commits = getCommits(args);
        if (commits.length > 0) {
            console.log(JSON.stringify(commits[commits.length - 1]));
        }
    })
    .command('get-changed-files', '', buildOptions, (args) => {
        const commits = getCommits(args);
        const changedFiles = getChangedFiles(commits);
        console.log(JSON.stringify(changedFiles));
    })
    .command('get-actor-configs', '', actorSelectionOptions, async ({ actors, ignore }) => {
        const allActorConfigs = await readConfigFile();
        const actorConfigs = selectActors({ actors, ignore }, allActorConfigs);
        console.log(JSON.stringify(actorConfigs));
    })
    .command(
        'get-affected-actors',
        '',
        (args) => actorSelectionOptions(buildOptions(args)),
        async (config) => {
            const actorsChanged = await resolveChangedActors(config, { isLatest: false });
            console.log(JSON.stringify(actorsChanged));
        },
    )
    .command(
        'report-tests',
        '',
        (args) =>
            args
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
        (args) => actorSelectionOptions(buildOptions(args)).option('dry-run', { type: 'boolean', default: false }),
        async (config) => {
            const actorsChanged = await resolveChangedActors(config, { isLatest: false });
            // https://github.com/apify-store/google-maps#:actors/lukaskrivka_google-maps-with-contact-details
            // git@github.com:apify-store/google-maps#:actors/lukaskrivka_google-maps-with-contact-details
            const repoUrl = spawnCommandInGhWorkspace(`git remote get-url origin`).replace(
                /^https:\/\/github\.com\//,
                'git@github.com:',
            );

            const builds = await runBuilds({
                repoUrl,
                actorConfigs: actorsChanged,
                branch: config.sourceBranch.replace('origin/', ''),
                dryRun: config.dryRun,
                useDockerCache: config.useDockerCache,
            });
            console.log(JSON.stringify(builds));
        },
    )
    .command(
        'release',
        '',
        (args) =>
            actorSelectionOptions(args)
                .option('push-event-path', { type: 'string', demandOption: true })
                .option('dry-run', { type: 'boolean', default: false })
                .option('report-slack-channel', { type: 'string' })
                .option('release-slack-channel', { type: 'string' })
                .option('use-docker-cache', { type: 'boolean', default: false }),
        async (args) => {
            const { branch, changedFiles, repoUrl, commits, changelog, repository, author } = await getPushData(
                args.pushEventPath,
            );
            const isLatest = true;
            const allActorConfigs = await readConfigFile();
            const actorConfigs = selectActors(args, allActorConfigs);
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
                actorConfigs: actorsChanged,
                branch,
                dryRun,
                useDockerCache: args.useDockerCache,
            });
            console.error(JSON.stringify(builds));

            await notifyToSlack({
                changedFiles,
                commits,
                changelog,
                repository,
                dryRun,
                author,
                reportSlackChannel,
                releaseSlackChannel,
            });
        },
    )
    .command(
        'build-from-local',
        '',
        (args) => actorSelectionOptions(args).option('dry-run', { type: 'boolean', default: false }),
        async ({ actors, ignore, dryRun }) => {
            const allActorConfigs = await readConfigFile();
            const actorConfigs = selectActors({ actors, ignore }, allActorConfigs);
            const builds = await runBuildsFromLocal({ actorConfigs, dryRun });
            console.log(JSON.stringify(builds));
        },
    )
    .command('delete-old-builds', '', actorSelectionOptions, async ({ actors, ignore }) => {
        const allActorConfigs = await readConfigFile();
        const actorConfigs = selectActors({ actors, ignore }, allActorConfigs);
        await deleteOldBuilds(actorConfigs);
    })
    .strictCommands()
    .demandCommand(1, 'Command is required')
    .fail((msg, err, yargsInstance) => {
        // Errors thrown from a command handler (e.g. an unknown actor passed to --actors/--ignore,
        // or a missing config file) arrive here as `err`. A malformed selection must fail loudly
        // rather than silently operate on the wrong set of actors — print the message, no stack.
        if (err) {
            console.error(`[ERROR]: ${err.message}`);
        } else {
            // Argument-parsing/validation failure — keep yargs' usage output.
            console.error(yargsInstance.help());
            console.error(`\n${msg}`);
        }
        process.exit(1);
    })
    .parse(hideBin(process.argv));
