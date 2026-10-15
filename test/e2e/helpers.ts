import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Shared by the e2e suites. They run the shipped CLI bundle against Actors in the isolated
// `test-tools-testing-sandbox` org, whose token can reach nothing else.
export const TOKEN_ENV_VAR = 'E2E_TEST_APIFY_TOKEN_DBYPODOIHUZABNQTR';
export const token = process.env[TOKEN_ENV_VAR];

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const bundlePath = path.join(projectRoot, '.github/cli/apify-test-tools.mjs');

// Proxy and CA settings pass through so the API is reachable behind a proxy; no other variable does.
const networkEnv = Object.fromEntries(
    ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS']
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]!]),
);
const baseEnv = { PATH: process.env.PATH ?? '', HOME: os.tmpdir() };
// The CLI gets only the sandbox token, under the name the fixture configs point at.
export const cliEnv = { ...baseEnv, ...networkEnv, [TOKEN_ENV_VAR]: token ?? '' };
export const gitEnv = {
    ...baseEnv,
    ...networkEnv,
    GIT_AUTHOR_NAME: 'Tester',
    GIT_AUTHOR_EMAIL: 'tester@example.com',
    GIT_COMMITTER_NAME: 'Tester',
    GIT_COMMITTER_EMAIL: 'tester@example.com',
};

// Spawned processes are blocking, so vitest's own timeouts can't stop one that hangs. apify-client
// retries an unreachable API for minutes, so a hang is killed here and fails with a clear error.
export const PROCESS_TIMEOUT_MS = 8 * 60_000;

export const runCli = (cwd: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [bundlePath, ...args], {
        cwd,
        env: cliEnv,
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT_MS,
    });
    const error = result.error ? `\n${result.error.message}` : '';
    return { status: result.status, stdout: result.stdout, stderr: result.stderr + error };
};

export interface ActorBuild {
    buildId: string;
    actorRawId: string;
    buildNumber: string;
    actorFullName: string;
}
