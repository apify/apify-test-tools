#!/usr/bin/env node

import process from 'node:process';

import yargs, { type Argv } from 'yargs';
// eslint-disable-next-line import/extensions --- With .js, it cannot find types
import { hideBin } from 'yargs/helpers';

import { runBuilds } from './build.js';
import { getChangedActors } from './diff-changes.js';
import { getChangedFiles, getCommits } from './git.js';
import { getPushData } from './github.js';
import { notifyToSlack } from './slack.js';
import { reportTestResults } from './test-report.js';
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
    .command('get-affected-actors', '', buildOptions, async (args) => {
        const commits = getCommits(args);
        const changedFiles = getChangedFiles(commits);
        const actorConfigs = await getRepoActors();
        const actorsChanged = getChangedActors({
            filepathsChanged: changedFiles,
            actorConfigs,
            isLatest: false,
            commits,
        });
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
        async (args) => {
            const commits = getCommits(args);
            const changedFiles = getChangedFiles(commits);
            const actorConfigs = await getRepoActors();
            const actorsChanged = getChangedActors({
                filepathsChanged: changedFiles,
                actorConfigs,
                commits,
            });
            // https://github.com/apify-store/google-maps#:actors/lukaskrivka_google-maps-with-contact-details
            // git@github.com:apify-store/google-maps#:actors/lukaskrivka_google-maps-with-contact-details
            const repoUrl = spawnCommandInGhWorkspace(`git remote get-url origin`).replace(
                /^https:\/\/github\.com\//,
                'git@github.com:',
            );

            const builds = await runBuilds({
                repoUrl,
                actorConfigs: actorsChanged,
                branch: args.sourceBranch.replace('origin/', ''),
                dryRun: args.dryRun,
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

            // TODO: build circle actors
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
    .strictCommands()
    .demandCommand(1, 'Command is required')
    .parse(hideBin(process.argv));
