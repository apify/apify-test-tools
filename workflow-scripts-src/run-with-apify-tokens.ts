#!/usr/bin/env node
// Runs apify-test-tools and passes it only secrets needed for the Actors, no other secrets are leaked.
//
//     jq ... | node .github/scripts/run-with-apify-tokens.mjs apify-test-tools build --version-number 0.99
//
// The step passes the reusable workflow's whole secrets map as WORKFLOW_SECRETS. The token names
// come from `tokenEnvVar` in the repo's apify-test-tools.config.json, which is the same file
// apify-test-tools itself reads, so the two can't drift. Everything else in the secrets map (npm,
// Slack, GitHub, anything else the repo holds) is left out, and WORKFLOW_SECRETS itself is dropped,
// so the blob never reaches the CLI or anything under node_modules.
//
// Each token is looked up in the CONFIG_SECRETS secret first, a JSON object of secret name -> value,
// and then among the top-level secrets, which is where `secrets: inherit` puts them. The secrets the
// workflows read by name (NPM_TOKEN, TESTER_APIFY_TOKEN, ...) never come from CONFIG_SECRETS.
//
// The command runs without a shell, so branch names and other interpolated arguments are passed
// through as literal argv entries.

import { spawnSync } from 'node:child_process';

import { CONFIG_FILE_NAME, readBaseConfigFile } from '../bin/utils/config/load-config.js';

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const [command, ...args] = process.argv.slice(2);
if (!command) fail('Usage: run-with-apify-tokens.mjs <command> [args...]');

const { WORKFLOW_SECRETS, ...baseEnv } = process.env;
if (!WORKFLOW_SECRETS) {
    fail('WORKFLOW_SECRETS is not set. Add `WORKFLOW_SECRETS: ${{ toJSON(secrets) }}` to the step env.');
}

let workflowSecrets: unknown;
try {
    workflowSecrets = JSON.parse(WORKFLOW_SECRETS);
} catch (error) {
    fail(`WORKFLOW_SECRETS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
const workflowSecretsMap = workflowSecrets;
if (!isRecord(workflowSecretsMap)) {
    fail('WORKFLOW_SECRETS must be a JSON object of secret names and values.');
}

// Never includes the parse error: Node quotes the input in it, and the input is a secret.
const unpackConfigSecrets = (): Record<string, unknown> => {
    const packed = workflowSecretsMap.CONFIG_SECRETS;
    if (!packed) return {};
    if (typeof packed !== 'string') fail('The CONFIG_SECRETS secret is not valid JSON.');
    let value: unknown;
    try {
        value = JSON.parse(packed);
    } catch {
        fail('The CONFIG_SECRETS secret is not valid JSON.');
    }
    if (!isRecord(value)) {
        fail('The CONFIG_SECRETS secret must be a JSON object.');
    }
    return value;
};

const secrets = { ...workflowSecretsMap, ...unpackConfigSecrets() };

let actorConfigs: Awaited<ReturnType<typeof readBaseConfigFile>>;
try {
    actorConfigs = await readBaseConfigFile();
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
}

const tokenNames = [...new Set(actorConfigs.map(({ tokenEnvVar }) => tokenEnvVar))].sort();

// Declared but absent is a warning, not an error. A repo can carry an Actor whose token isn't
// configured and still build fine as long as that Actor never changes, and apify-test-tools raises
// a precise error naming the Actor at the point it actually needs the token.
const missing = tokenNames.filter((name) => !(name in secrets));
if (missing.length > 0) {
    console.error(
        `Warning: ${CONFIG_FILE_NAME} declares ${missing.join(', ')}, but no such secret was passed ` +
            `to this workflow, neither inside CONFIG_SECRETS nor inherited. Check the repository secrets ` +
            `and the workflow's \`secrets:\` if a build fails on a missing token.`,
    );
}

const present = tokenNames.filter((name) => name in secrets);

// Names only. The values are secrets and must never be printed, even though the runner masks
// registered secrets in logs.
console.error(`Passing ${present.length} Actor token(s) to \`${command}\`: ${present.join(', ') || '(none)'}`);

const env = { ...baseEnv };
for (const name of present) {
    const value = secrets[name];
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
