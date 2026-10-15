import { spawn } from 'node:child_process';
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

// Processes are spawned asynchronously: a blocking spawn would stall the test worker for the length
// of a build, long enough for vitest's own worker RPC to time out. The kill timeout still applies on
// top of vitest's, since apify-client retries an unreachable API for minutes.
export const PROCESS_TIMEOUT_MS = 8 * 60_000;

export interface ProcessResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

export const runProcess = async (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
): Promise<ProcessResult> =>
    new Promise((resolve) => {
        const child = spawn(command, args, { ...options, timeout: PROCESS_TIMEOUT_MS });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.on('error', (error) => {
            stderr += `\n${error.message}`;
        });
        child.on('close', (status, signal) => {
            resolve({ status, stdout, stderr: signal ? `${stderr}\nKilled by ${signal}` : stderr });
        });
    });

export const runCli = async (cwd: string, ...args: string[]) =>
    runProcess(process.execPath, [bundlePath, ...args], { cwd, env: cliEnv });

export interface ActorBuild {
    buildId: string;
    actorRawId: string;
    buildNumber: string;
    actorFullName: string;
}
