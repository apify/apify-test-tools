#!/usr/bin/env node
// Runs apify-test-tools and passes it only secrets needed for the Actors, no other secrets are leaked.
//
//     node .github/scripts/run-with-apify-tokens.mjs apify-test-tools build --target-branch ...
//
// The step passes the whole secrets map as ALL_SECRETS. The token names come from `tokenEnvVar` in
// the repo's apify-test-tools.config.json, which is the same file apify-test-tools itself reads, so
// the two can't drift. Everything else in the secrets map (npm, Slack, GitHub, anything else the
// repo holds) is left out, and ALL_SECRETS itself is dropped, so the blob never reaches the CLI or
// anything under node_modules.
//
// The command runs without a shell, so branch names and other interpolated arguments are passed
// through as literal argv entries.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Resolved against the working directory, matching how apify-test-tools' own readConfigFile
// locates it.
const CONFIG_FILE_NAME = 'apify-test-tools.config.json';

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const [command, ...args] = process.argv.slice(2);
if (!command) fail('Usage: run-with-apify-tokens.mjs <command> [args...]');

const { ALL_SECRETS, ...baseEnv } = process.env;
const allSecretsJson =
    ALL_SECRETS || fail('ALL_SECRETS is not set. Add `ALL_SECRETS: ${{ toJSON(secrets) }}` to the step env.');

let secrets: unknown;
try {
    secrets = JSON.parse(allSecretsJson);
} catch (error) {
    fail(`ALL_SECRETS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
const secretsMap = secrets;
if (!isRecord(secretsMap)) {
    fail('ALL_SECRETS must be a JSON object of secret names and values.');
}

const configPath = path.resolve(process.cwd(), CONFIG_FILE_NAME);
let config: unknown;
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
    fail(`Cannot read "${configPath}": ${error instanceof Error ? error.message : String(error)}`);
}

const configObject = config;
if (!isRecord(configObject) || !Array.isArray(configObject.actors)) {
    fail(`"${configPath}" must have an "actors" array at the top level.`);
}

const tokenNames: string[] = [];
const entriesWithoutToken: unknown[] = [];

const actors: unknown[] = configObject.actors;
for (const [index, actor] of actors.entries()) {
    const tokenEnvVar = isRecord(actor) ? actor.tokenEnvVar : undefined;
    if (typeof tokenEnvVar !== 'string' || tokenEnvVar === '') {
        entriesWithoutToken.push((isRecord(actor) ? actor.actorFullName : undefined) ?? `entry at index ${index}`);
        continue;
    }
    if (!tokenNames.includes(tokenEnvVar)) tokenNames.push(tokenEnvVar);
}

tokenNames.sort();

if (entriesWithoutToken.length > 0) {
    console.error(
        `Warning: no "tokenEnvVar" in ${CONFIG_FILE_NAME} for: ${entriesWithoutToken.join(', ')}. ` +
            `Building those Actors will fail.`,
    );
}

// Declared but absent is a warning, not an error. A repo can carry an Actor whose token isn't
// configured and still build fine as long as that Actor never changes, and apify-test-tools raises
// a precise error naming the Actor at the point it actually needs the token.
const missing = tokenNames.filter((name) => !(name in secretsMap));
if (missing.length > 0) {
    console.error(
        `Warning: ${CONFIG_FILE_NAME} declares ${missing.join(', ')}, but no such secret was passed ` +
            `to this workflow. Check the repository secrets if a build fails on a missing token.`,
    );
}

const present = tokenNames.filter((name) => name in secretsMap);

// Names only. The values are secrets and must never be printed, even though the runner masks
// registered secrets in logs.
console.error(`Passing ${present.length} Actor token(s) to \`${command}\`: ${present.join(', ') || '(none)'}`);

const env = { ...baseEnv };
for (const name of present) {
    const value = secretsMap[name];
    if (typeof value !== 'string') fail(`Secret "${name}" must be a string.`);
    env[name] = value;
}

const result = spawnSync(command, args, { stdio: 'inherit', env });

if (result.error) {
    fail(`Failed to run \`${command}\`: ${result.error.message}`);
}

// Preserve the child's exit code so the step fails exactly when the command does. A child killed
// by a signal reports a null status, which would otherwise be read as success.
process.exit(result.status ?? 1);
