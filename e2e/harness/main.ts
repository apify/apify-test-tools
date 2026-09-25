/**
 * End-to-end tests of the CLI, the library and the reusable workflows together. See e2e/README.md.
 *
 *   npm run e2e -- local                  offline change-detection check, no credentials
 *   npm run e2e -- prepare --run-id <id>  build the sandbox checkout, no credentials
 *   npm run e2e -- run --run-id <id>      run the scenarios in the sandbox repo (prepares if needed)
 *   npm run e2e -- cleanup --run-id <id>  remove the run's PRs, branches and pending workflow runs
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { defaultWorkDir, prepareSandbox } from './fixture.js';
import { runLocally } from './local.js';
import { cleanUpSandbox, runInSandbox } from './sandbox.js';

const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set. See e2e/README.md for what each credential is.`);
    return value;
};

const {
    positionals: [command],
    values,
} = parseArgs({
    allowPositionals: true,
    options: {
        'run-id': { type: 'string' },
        'work-dir': { type: 'string' },
    },
});

const runId = values['run-id'] ?? `local-${Date.now().toString(36)}`;
const workDir = values['work-dir'] ?? defaultWorkDir(runId);

try {
    switch (command) {
        case 'prepare':
            prepareSandbox({ runId, workDir });
            break;

        case 'local':
            await runLocally({ runId, git: prepareSandbox({ runId, workDir }) });
            break;

        case 'run': {
            const credentials = {
                githubToken: requireEnv('SANDBOX_GITHUB_TOKEN'),
                ownerToken: requireEnv('E2E_APIFY_TOKEN'),
                testerToken: requireEnv('E2E_TESTER_APIFY_TOKEN'),
            };
            if (!fs.existsSync(workDir)) prepareSandbox({ runId, workDir });
            await runInSandbox({ runId, workDir, credentials });
            break;
        }

        case 'cleanup':
            await cleanUpSandbox({ runId, githubToken: requireEnv('SANDBOX_GITHUB_TOKEN') });
            break;

        default:
            console.error('Usage: npm run e2e -- <local|prepare|run|cleanup> [--run-id <id>] [--work-dir <dir>]');
            process.exit(1);
    }
} catch (error) {
    // The checks already printed what failed; the stack of a failed check is noise.
    console.error(`\n${(error as Error).message}`);
    process.exit(1);
}
