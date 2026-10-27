import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../.github/scripts/run-with-apify-tokens.mjs', import.meta.url));

// Three Actors, each with its own token, so a test can leave any of them out.
const CONFIG = {
    actors: [
        { actorFullName: 'team/one', tokenEnvVar: 'TOKEN_ONE' },
        { actorFullName: 'team/two', tokenEnvVar: 'TOKEN_TWO' },
        { actorFullName: 'team/three', tokenEnvVar: 'TOKEN_THREE' },
    ],
};

// The command the wrapper runs prints what it was handed, so a test sees exactly what got through.
const PRINT_ENV = `console.log(JSON.stringify({
    TOKEN_ONE: process.env.TOKEN_ONE,
    TOKEN_TWO: process.env.TOKEN_TWO,
    TOKEN_THREE: process.env.TOKEN_THREE,
    NPM_TOKEN: process.env.NPM_TOKEN,
    WORKFLOW_SECRETS: process.env.WORKFLOW_SECRETS,
}))`;

let cwd: string;

// `workflowSecrets` is what the step's `toJSON(secrets)` holds inside the reusable workflow.
const run = (workflowSecrets: Record<string, string>) => {
    const result = spawnSync(process.execPath, [SCRIPT, process.execPath, '-e', PRINT_ENV], {
        cwd,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, WORKFLOW_SECRETS: JSON.stringify(workflowSecrets) },
    });
    return { ...result, env: result.status === 0 ? JSON.parse(result.stdout) : undefined };
};

describe('run-with-apify-tokens.mjs', () => {
    beforeAll(async () => {
        cwd = await mkdtemp(path.join(os.tmpdir(), 'run-with-apify-tokens-'));
        await writeFile(path.join(cwd, 'apify-test-tools.config.json'), JSON.stringify(CONFIG));
    });

    afterAll(async () => {
        await rm(cwd, { recursive: true, force: true });
    });

    it('passes on inherited secrets, as `secrets: inherit` sends them', () => {
        const { status, stderr, env } = run({
            TOKEN_ONE: 'one',
            TOKEN_TWO: 'two',
            TOKEN_THREE: 'three',
            NPM_TOKEN: 'npm',
        });
        expect(status, stderr).toBe(0);
        expect(env).toStrictEqual({ TOKEN_ONE: 'one', TOKEN_TWO: 'two', TOKEN_THREE: 'three' });
    });

    it('unpacks the tokens from the CONFIG_SECRETS secret', () => {
        const { status, stderr, env } = run({
            CONFIG_SECRETS: JSON.stringify({ TOKEN_ONE: 'one', TOKEN_TWO: 'two', TOKEN_THREE: 'three' }),
            NPM_TOKEN: 'npm',
        });
        expect(status, stderr).toBe(0);
        expect(env).toStrictEqual({ TOKEN_ONE: 'one', TOKEN_TWO: 'two', TOKEN_THREE: 'three' });
    });

    it('passes on only the config names when CONFIG_SECRETS holds every secret of the caller', () => {
        const { status, stderr, env } = run({
            CONFIG_SECRETS: JSON.stringify({
                TOKEN_ONE: 'one',
                TOKEN_TWO: 'two',
                TOKEN_THREE: 'three',
                NPM_TOKEN: 'npm',
                github_token: 'gh',
            }),
        });
        expect(status, stderr).toBe(0);
        expect(env).toStrictEqual({ TOKEN_ONE: 'one', TOKEN_TWO: 'two', TOKEN_THREE: 'three' });
    });

    it('prefers CONFIG_SECRETS over an inherited secret of the same name', () => {
        const { status, stderr, env } = run({
            CONFIG_SECRETS: JSON.stringify({ TOKEN_ONE: 'from-config-secrets' }),
            TOKEN_ONE: 'inherited',
            TOKEN_TWO: 'inherited',
        });
        expect(status, stderr).toBe(0);
        expect(env).toStrictEqual({ TOKEN_ONE: 'from-config-secrets', TOKEN_TWO: 'inherited' });
    });

    it('warns about a token the config declares but nothing passes, and runs anyway', () => {
        const { status, stderr, env } = run({
            CONFIG_SECRETS: JSON.stringify({ TOKEN_ONE: 'one', TOKEN_TWO: 'two' }),
        });
        expect(status, stderr).toBe(0);
        expect(stderr).toContain('declares TOKEN_THREE, but no such secret was passed');
        expect(env).toStrictEqual({ TOKEN_ONE: 'one', TOKEN_TWO: 'two' });
    });

    it.each([
        ['is not JSON', 'apify_api_xyzzy', 'The CONFIG_SECRETS secret is not valid JSON.'],
        ['is a JSON string', '"apify_api_xyzzy"', 'The CONFIG_SECRETS secret must be a JSON object.'],
        ['is a JSON array', '["apify_api_xyzzy"]', 'The CONFIG_SECRETS secret must be a JSON object.'],
    ])('fails without printing the value when CONFIG_SECRETS %s', (_, packed, message) => {
        const { status, stdout, stderr } = run({ CONFIG_SECRETS: packed });
        expect(status).toBe(1);
        expect(stderr).toContain(message);
        expect(stdout + stderr).not.toContain('xyzzy');
    });
});
