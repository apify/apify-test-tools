import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../.github/scripts/run-with-apify-tokens.mjs', import.meta.url));

// team tests with its build tokens, team/two overriding both of its group's, and the partner group tests with a
// token of its own, so the build and test tokens differ.
const CONFIG = {
    mode: 'grouped',
    groups: {
        team: {
            buildTokenEnvVar: 'TOKEN_ONE',
            testTokenEnvVar: 'TOKEN_ONE',
            actors: [
                { folder: 'actors/one', actorFullName: 'team/one' },
                {
                    folder: 'actors/two',
                    actorFullName: 'team/two',
                    buildTokenEnvVar: 'TOKEN_TWO',
                    testTokenEnvVar: 'TOKEN_TWO',
                },
            ],
        },
        partner: {
            buildTokenEnvVar: 'TOKEN_THREE',
            testTokenEnvVar: 'TESTER_TOKEN',
            actors: [{ folder: 'actors/three', actorFullName: 'partner/three' }],
        },
    },
};

// The command the wrapper runs prints what it was handed, so a test sees exactly what got through.
const PRINT_ENV = `console.log(JSON.stringify({
    TOKEN_ONE: process.env.TOKEN_ONE,
    TOKEN_TWO: process.env.TOKEN_TWO,
    TOKEN_THREE: process.env.TOKEN_THREE,
    TESTER_TOKEN: process.env.TESTER_TOKEN,
    NPM_TOKEN: process.env.NPM_TOKEN,
    CONFIG_SECRETS: process.env.CONFIG_SECRETS,
}))`;

let cwd: string;

const ALL_SECRETS = { TOKEN_ONE: 'one', TOKEN_TWO: 'two', TOKEN_THREE: 'three', TESTER_TOKEN: 'tester' };
const BUILD_TOKENS = { TOKEN_ONE: 'one', TOKEN_TWO: 'two', TOKEN_THREE: 'three' };

// `configSecrets` is the CONFIG_SECRETS secret the step passes in the env var of the same name: an object is
// serialized, a string passed as it is, and undefined leaves the variable unset, as when the caller passes none.
const run = (
    configSecrets: Record<string, string> | string | undefined,
    tokens: string[] = ['--tokens', 'build'],
    dir = cwd,
    stepEnv: Record<string, string> = {},
) => {
    const packed = typeof configSecrets === 'object' ? JSON.stringify(configSecrets) : configSecrets;
    const result = spawnSync(process.execPath, [SCRIPT, ...tokens, process.execPath, '-e', PRINT_ENV], {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ...stepEnv, ...(packed !== undefined && { CONFIG_SECRETS: packed }) },
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

    it('unpacks the tokens from the CONFIG_SECRETS secret', () => {
        const { status, stderr, env } = run(ALL_SECRETS);
        expect(status, stderr).toBe(0);
        expect(env).toStrictEqual(BUILD_TOKENS);
        expect(stderr).toContain('Passing 3 build token(s) to');
    });

    it('passes on only the config names when CONFIG_SECRETS holds every secret of the caller', () => {
        const { status, stderr, env } = run({ ...ALL_SECRETS, NPM_TOKEN: 'npm', github_token: 'gh' });
        expect(status, stderr).toBe(0);
        expect(env).toStrictEqual(BUILD_TOKENS);
    });

    it("passes on the tokens the tests run with: each Actor's testTokenEnvVar", () => {
        const { status, stderr, env } = run(ALL_SECRETS, ['--tokens', 'test']);
        expect(status, stderr).toBe(0);
        expect(env).toStrictEqual({ TOKEN_ONE: 'one', TOKEN_TWO: 'two', TESTER_TOKEN: 'tester' });
        expect(stderr).toContain('Passing 3 test token(s) to');
    });

    // `secrets: inherit` hands the workflow the repository's secrets one by one, which it doesn't read
    it('passes no token without CONFIG_SECRETS, warning about each, and runs anyway', () => {
        const { status, stderr, env } = run(undefined);
        expect(status, stderr).toBe(0);
        expect(env).toStrictEqual({});
        expect(stderr).toContain(
            'declares TOKEN_ONE, TOKEN_THREE, TOKEN_TWO as `buildTokenEnvVar`, but the CONFIG_SECRETS secret has no such entry',
        );
        expect(stderr).toContain('Passing 0 build token(s) to');
    });

    it.each([[[]], [['build']], [['--tokens', 'deploy']]])('fails without a valid --tokens: %j', (tokens) => {
        const { status, stderr } = run(ALL_SECRETS, tokens);
        expect(status).toBe(1);
        expect(stderr).toContain('Usage: run-with-apify-tokens.mjs --tokens <build|test>');
    });

    it('fails without the config, before starting the command', async () => {
        const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'run-with-apify-tokens-empty-'));
        try {
            const { status, stdout, stderr } = run(ALL_SECRETS, ['--tokens', 'build'], emptyDir);
            expect(status).toBe(1);
            expect(stderr).toContain('Config file "apify-test-tools.config.json" not found');
            expect(stdout).toBe('');
        } finally {
            await rm(emptyDir, { recursive: true, force: true });
        }
    });

    it('warns about a token the config declares but nothing passes, and runs anyway', () => {
        const { status, stderr, env } = run({ TOKEN_ONE: 'one', TOKEN_TWO: 'two' });
        expect(status, stderr).toBe(0);
        expect(stderr).toContain(
            'declares TOKEN_THREE as `buildTokenEnvVar`, but the CONFIG_SECRETS secret has no such entry',
        );
        expect(env).toStrictEqual({ TOKEN_ONE: 'one', TOKEN_TWO: 'two' });
    });

    it.each([
        ['is not JSON', 'apify_api_xyzzy', 'The CONFIG_SECRETS secret is not valid JSON.'],
        ['is a JSON string', '"apify_api_xyzzy"', 'The CONFIG_SECRETS secret must be a JSON object.'],
        ['is a JSON array', '["apify_api_xyzzy"]', 'The CONFIG_SECRETS secret must be a JSON object.'],
    ])('fails without printing the value when CONFIG_SECRETS %s', (_, packed, message) => {
        const { status, stdout, stderr } = run(packed);
        expect(status).toBe(1);
        expect(stderr).toContain(message);
        expect(stdout + stderr).not.toContain('xyzzy');
    });
});
