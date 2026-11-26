#!/usr/bin/env node
// Runs apify-test-tools and passes it only the Apify tokens it needs, no other secrets are leaked.
//
//     jq ... | node .github/scripts/run-with-apify-tokens.mjs --tokens build apify-test-tools build --version-number 0.99
//     node .github/scripts/run-with-apify-tokens.mjs --tokens test apify-test-tools test < builds.json
//
// `--tokens build` passes the tokens that build the Actors, each Actor's `buildTokenEnvVar` in the repo's
// apify-test-tools.config.json. `--tokens test` passes the tokens the platform tests run with, each
// Actor's `testTokenEnvVar`.
//
// The step passes the CONFIG_SECRETS secret in the env var of the same name: a JSON object of secret
// name -> value, the only place the tokens are read from. The token names come from the repo's
// apify-test-tools.config.json, read with apify-test-tools' own parser, so the two can't drift.
// Everything else in CONFIG_SECRETS is left out, and CONFIG_SECRETS itself is dropped, so the blob
// never reaches the CLI or anything under node_modules. Variables the step sets itself, like
// SCRIPTS_PATH, pass through.
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

const TOKEN_FIELDS = { build: 'buildTokenEnvVar', test: 'testTokenEnvVar' } as const;
type TokenKind = keyof typeof TOKEN_FIELDS;
const isTokenKind = (value: string | undefined): value is TokenKind => value === 'build' || value === 'test';

const [flag, kind, command, ...args] = process.argv.slice(2);
if (flag !== '--tokens' || !isTokenKind(kind) || !command) {
    fail('Usage: run-with-apify-tokens.mjs --tokens <build|test> <command> [args...]');
}
const tokenField = TOKEN_FIELDS[kind];

const { CONFIG_SECRETS, ...baseEnv } = process.env;

// Never includes the parse error: Node quotes the input in it, and the input is a secret.
const unpackConfigSecrets = (): Record<string, unknown> => {
    if (!CONFIG_SECRETS) return {};
    let value: unknown;
    try {
        value = JSON.parse(CONFIG_SECRETS);
    } catch {
        fail('The CONFIG_SECRETS secret is not valid JSON.');
    }
    if (!isRecord(value)) {
        fail('The CONFIG_SECRETS secret must be a JSON object.');
    }
    return value;
};

const secrets = unpackConfigSecrets();

let actorConfigs: Awaited<ReturnType<typeof readBaseConfigFile>>;
try {
    actorConfigs = await readBaseConfigFile();
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
}

const tokenNames = [...new Set(actorConfigs.map((actorConfig) => actorConfig[tokenField]))].sort();

// Declared but absent is a warning, not an error. A repo can carry an Actor whose token isn't
// configured and still build fine as long as that Actor never changes, and apify-test-tools raises
// a precise error naming the Actor at the point it actually needs the token.
const missing = tokenNames.filter((name) => !(name in secrets));
if (missing.length > 0) {
    console.error(
        `Warning: ${CONFIG_FILE_NAME} declares ${missing.join(', ')} as \`${tokenField}\`, but the ` +
            `CONFIG_SECRETS secret has no such entry. Add it to CONFIG_SECRETS in the calling workflow's ` +
            `\`secrets:\` if a ${kind} fails on a missing token.`,
    );
}

const present = tokenNames.filter((name) => name in secrets);

// Names only. The values are secrets and must never be printed, even though the runner masks
// registered secrets in logs.
console.error(`Passing ${present.length} ${kind} token(s) to \`${command}\`: ${present.join(', ') || '(none)'}`);

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
