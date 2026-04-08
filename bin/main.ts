#!/usr/bin/env node

import process from 'node:process';

import yargs, { type Argv } from 'yargs';
// eslint-disable-next-line import/extensions --- With .js, it cannot find types
import { hideBin } from 'yargs/helpers';

import { deleteOldBuilds, runBuilds } from './build.js';
import { getChangedActors } from './diff-changes.js';
import { getBranchOnlyChangedFiles, getChangedFiles, getCommits, hasMergeFromTarget } from './git.js';
import { getPushData } from './github.js';
import { notifyToSlack } from './slack.js';
import { reportTestResults } from './test-report.js';
import type { Config } from './types.js';
import { getRepoActors, setCwd, spawnCommandInGhWorkspace } from './utils.js';

/**
 * Middlewares to be run before every command execution
 */
const middlewares = [setCwd];

const buildOptions = (y: Argv) => {
    return y
        .option('target-branch', {
            type: 'string',
            demandOption: true,
        })
        .option('source-branch', {
            type: 'string',
            demandOption: true,
        })
        .option('base-commit', {
            type: 'string',
        });
};

const resolveChangedActors = async (
    { targetBranch, sourceBranch, baseCommit }: Config,
    { isLatest }: { isLatest: boolean },
) => {
    const actorConfigs = await getRepoActors();

    // This is an optimization for the common case where a branch only has cosmetic changes but had to merge in
    // functional changes from master (being up-to-date is a CI requirement). Master is already validated, and
    // since the branch has no functional changes of its own, there is nothing new to validate.
    // Exception: if the branch has any functional changes alongside the merge, we must re-test — even
    // individually validated changes can have novel interactions when combined.
    if (hasMergeFromTarget(sourceBranch, targetBranch)) {
        console.error(
            '[MERGE-FROM-TARGET-OPTIMIZATION]: There is merge from target branch, checking if there are no functional changes in our own branch. If so, we can skip tests',
        );
        const branchOnlyFiles = getBranchOnlyChangedFiles(sourceBranch, targetBranch);
        // Omit baseCommit to get full branch history. Validated functional commits can still interact with merged ones
        const allBranchCommits = getCommits({ sourceBranch, targetBranch, baseCommit: undefined });
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
    const commits = getCommits({ targetBranch, sourceBranch, baseCommit });
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
    .command(
        'get-actor-configs',
        '',
        (_) => _,
        async () => {
            const actorConfigs = await getRepoActors();
            console.log(JSON.stringify(actorConfigs));
        },
    )
    .command('get-affected-actors', '', buildOptions, async ({ targetBranch, sourceBranch, baseCommit }) => {
        const actorsChanged = await resolveChangedActors(
            { targetBranch, sourceBranch, baseCommit },
            { isLatest: false },
        );
        console.log(JSON.stringify(actorsChanged));
    })
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
        (args) => buildOptions(args).option('dry-run', { type: 'boolean', default: false }),
        async ({ targetBranch, sourceBranch, baseCommit, dryRun }) => {
            const actorsChanged = await resolveChangedActors(
                { targetBranch, sourceBranch, baseCommit },
                { isLatest: false },
            );
            // https://github.com/apify-store/google-maps#:actors/lukaskrivka_google-maps-with-contact-details
            // git@github.com:apify-store/google-maps#:actors/lukaskrivka_google-maps-with-contact-details
            const repoUrl = spawnCommandInGhWorkspace(`git remote get-url origin`).replace(
                /^https:\/\/github\.com\//,
                'git@github.com:',
            );

            const builds = await runBuilds({
                repoUrl,
                actorConfigs: actorsChanged,
                branch: sourceBranch.replace('origin/', ''),
                dryRun,
            });
            console.log(JSON.stringify(builds));
        },
    )
    .command(
        'release',
        '',
        (args) =>
            args
                .option('push-event-path', { type: 'string', demandOption: true })
                .option('dry-run', { type: 'boolean', default: false })
                .option('report-slack-channel', { type: 'string' })
                .option('release-slack-channel', { type: 'string' }),
        async (args) => {
            const { branch, changedFiles, repoUrl, commits, changelog, repository, author } = await getPushData(
                args.pushEventPath,
            );
            const isLatest = true;
            const actorConfigs = await getRepoActors();
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
        'delete-old-builds',
        '',
        (_) => _,
        async () => {
            const actorConfigs = await getRepoActors();
            await deleteOldBuilds(actorConfigs);
        },
    )
    .strictCommands()
    .demandCommand(1, 'Command is required')
    .parse(hideBin(process.argv));
