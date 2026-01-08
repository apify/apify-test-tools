#!/usr/bin/env node

import process from 'process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
    getRepoActors,
    getChangedActors,
    spawnCommandInGhWorkspace,
    setCwd,
} from './utils.js';
import { runBuilds } from './build.js';
import { getChangedFiles, getCommits } from './git.js';
import { getPushData } from './github.js';
import { notifyToSlack } from './slack.js';
import { reportTestRestuls } from './test-report.js';

/**
 * Middlewares to be run before every command execution
 */
const middlewares = [setCwd];

const buildOptions = (y: yargs.Argv) => {
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
        })
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
    .command('get-actor-configs', '', (_) => _, async () => {
        const actorConfigs = await getRepoActors();
        console.log(JSON.stringify(actorConfigs));
    })
    .command('get-affected-actors', '', buildOptions, async (args) => {
        const commits = getCommits(args);
        const changedFiles = getChangedFiles(commits);
        const actorConfigs = await getRepoActors();
        const { actorsChanged } = getChangedActors({ filepathsChanged: changedFiles, actorConfigs, isLatest: false });
        console.log(JSON.stringify(actorsChanged));
    })
    .command(
        'report-tests',
        '',
        (args) => args
            .option('report-file', { type: 'string', demandOption: true })
            .option('job-url', { type: 'string' })
            .option('workflow-name', { type: 'string' })
            .option('repository', { type: 'string' }),
        async (args) => {
            await reportTestRestuls(args);
        })
    .command(
        'build',
        '',
        (args) => buildOptions(args)
            .option('dry-run', { type: 'boolean', default: false }),
        async (args) => {
            const commits = getCommits(args);
            const changedFiles = getChangedFiles(commits);
            const actorConfigs = await getRepoActors();
            const { actorsChanged } = getChangedActors({
                filepathsChanged: changedFiles,
                actorConfigs,
            });
            // https://github.com/apify-store/google-maps#:actors/lukaskrivka_google-maps-with-contact-details
            // git@github.com:apify-store/google-maps#:actors/lukaskrivka_google-maps-with-contact-details
            const repoUrl = spawnCommandInGhWorkspace(`git remote get-url origin`)
                .replace(/^https:\/\/github\.com\//, 'git@github.com:');

            const builds = await runBuilds({
                repoUrl,
                actorConfigs: actorsChanged,
                branch: args.sourceBranch.replace('origin/', ''),
                dryRun: args.dryRun,
            });
            console.log(JSON.stringify(builds));
        })
    .command(
        'release',
        '',
        (args) => args
            .option('push-event-path', { type: 'string', demandOption: true })
            .option('dry-run', { type: 'boolean', default: false }),
        async (args) => {
            const {
                branch,
                changedFiles,
                repoUrl,
                commits,
                changelog,
                repository,
                author,
            } = await getPushData(args.pushEventPath);
            const isLatest = true;
            const actorConfigs = await getRepoActors();
            const { actorsChanged } = getChangedActors({
                filepathsChanged: changedFiles,
                actorConfigs,
                isLatest,
            });
            const { dryRun } = args;
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
                author
            });
        })
    .strictCommands()
    .demandCommand(1, 'Command is required')
    .parse(hideBin(process.argv));
