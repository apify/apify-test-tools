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
    ALL_SECRETS: process.env.ALL_SECRETS,
}))`;

let cwd: string;

// `workflowSecrets` is what the step's `toJSON(secrets)` holds inside the reusable workflow.
const run = (workflowSecrets: Record<string, string>) => {
    const result = spawnSync(process.execPath, [SCRIPT, process.execPath, '-e', PRINT_ENV], {
        cwd,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ALL_SECRETS: JSON.stringify(workflowSecrets) },
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

    it('passes on top-level secrets, as `secrets: inherit` sends them', () => {
        const { status, stderr, env } = run({
            TOKEN_ONE: 'one',
            TOKEN_TWO: 'two',
            TOKEN_THREE: 'three',
            NPM_TOKEN: 'npm',
        });
        expect(status, stderr).toBe(0);
        expect(env).toStrictEqual({ TOKEN_ONE: 'one', TOKEN_TWO: 'two', TOKEN_THREE: 'three' });
    });

    it('unpacks the tokens from the ALL_SECRETS secret', () => {
        const { status, stderr, env } = run({
            ALL_SECRETS: JSON.stringify({ TOKEN_ONE: 'one', TOKEN_TWO: 'two', TOKEN_THREE: 'three', NPM_TOKEN: 'npm' }),
            github_token: 'gh',
        });
        expect(status, stderr).toBe(0);
        expect(env).toStrictEqual({ TOKEN_ONE: 'one', TOKEN_TWO: 'two', TOKEN_THREE: 'three' });
    });

    it('unpacks the tokens from the APIFY_ACTOR_TOKENS secret', () => {
        const { status, stderr, env } = run({
            APIFY_ACTOR_TOKENS: JSON.stringify({ TOKEN_ONE: 'one', TOKEN_TWO: 'two', TOKEN_THREE: 'three' }),
            NPM_TOKEN: 'npm',
        });
        expect(status, stderr).toBe(0);
        expect(env).toStrictEqual({ TOKEN_ONE: 'one', TOKEN_TWO: 'two', TOKEN_THREE: 'three' });
    });

    it('prefers APIFY_ACTOR_TOKENS, then secrets passed by name, then ALL_SECRETS', () => {
        const { status, stderr, env } = run({
            APIFY_ACTOR_TOKENS: JSON.stringify({ TOKEN_ONE: 'from-map' }),
            TOKEN_ONE: 'by-name',
            TOKEN_TWO: 'by-name',
            ALL_SECRETS: JSON.stringify({ TOKEN_ONE: 'from-all', TOKEN_TWO: 'from-all', TOKEN_THREE: 'from-all' }),
        });
        expect(status, stderr).toBe(0);
        expect(env).toStrictEqual({ TOKEN_ONE: 'from-map', TOKEN_TWO: 'by-name', TOKEN_THREE: 'from-all' });
    });

    it('warns about a token the config declares but nothing passes, and runs anyway', () => {
        const { status, stderr, env } = run({
            APIFY_ACTOR_TOKENS: JSON.stringify({ TOKEN_ONE: 'one', TOKEN_TWO: 'two' }),
        });
        expect(status, stderr).toBe(0);
        expect(stderr).toContain('declares TOKEN_THREE, but no such secret was passed');
        expect(env).toStrictEqual({ TOKEN_ONE: 'one', TOKEN_TWO: 'two' });
    });

    it.each([
        ['is not JSON', 'apify_api_xyzzy', 'The APIFY_ACTOR_TOKENS secret is not valid JSON.'],
        ['is a JSON string', '"apify_api_xyzzy"', 'The APIFY_ACTOR_TOKENS secret must be a JSON object.'],
        ['is a JSON array', '["apify_api_xyzzy"]', 'The APIFY_ACTOR_TOKENS secret must be a JSON object.'],
    ])('fails without printing the value when APIFY_ACTOR_TOKENS %s', (_, packed, message) => {
        const { status, stdout, stderr } = run({ APIFY_ACTOR_TOKENS: packed });
        expect(status).toBe(1);
        expect(stderr).toContain(message);
        expect(stdout + stderr).not.toContain('xyzzy');
    });

    it('fails without printing the value when ALL_SECRETS is not JSON', () => {
        const { status, stdout, stderr } = run({ ALL_SECRETS: '{"TOKEN_ONE": apify_api_xyzzy}' });
        expect(status).toBe(1);
        expect(stderr).toContain('The ALL_SECRETS secret is not valid JSON.');
        expect(stdout + stderr).not.toContain('xyzzy');
    });
});
