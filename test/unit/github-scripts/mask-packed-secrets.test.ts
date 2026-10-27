import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../.github/scripts/mask-packed-secrets.sh', import.meta.url));

const run = (env: { ALL_SECRETS?: string; APIFY_ACTOR_TOKENS?: string }) =>
    spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

const masks = (stdout: string) => stdout.split('\n').filter((line) => line !== '');

describe('mask-packed-secrets.sh', () => {
    it('registers every value of both secrets as a mask', () => {
        const { status, stdout, stderr } = run({
            ALL_SECRETS: JSON.stringify({ NPM_TOKEN: 'npm', github_token: 'gh' }),
            APIFY_ACTOR_TOKENS: JSON.stringify({ TOKEN_ONE: 'one' }),
        });
        expect(status, stderr).toBe(0);
        expect(masks(stdout)).toStrictEqual(['::add-mask::npm', '::add-mask::gh', '::add-mask::one']);
    });

    it('registers a multi-line value line by line, skipping empty lines', () => {
        const { status, stdout, stderr } = run({
            ALL_SECRETS: JSON.stringify({ DEPLOY_KEY: '-----BEGIN KEY-----\nabc\n\n-----END KEY-----\n' }),
        });
        expect(status, stderr).toBe(0);
        expect(masks(stdout)).toStrictEqual([
            '::add-mask::-----BEGIN KEY-----',
            '::add-mask::abc',
            '::add-mask::-----END KEY-----',
        ]);
    });

    it('skips values that are not strings', () => {
        const { status, stdout, stderr } = run({ APIFY_ACTOR_TOKENS: JSON.stringify({ TOKEN_ONE: 'one', COUNT: 1 }) });
        expect(status, stderr).toBe(0);
        expect(masks(stdout)).toStrictEqual(['::add-mask::one']);
    });

    it('does nothing when neither secret is passed', () => {
        const { status, stdout, stderr } = run({ ALL_SECRETS: '' });
        expect(status, stderr).toBe(0);
        expect(stdout).toBe('');
    });

    it.each([
        ['is not JSON', 'apify_api_xyzzy'],
        ['is a JSON string', '"apify_api_xyzzy"'],
        ['is a JSON array', '["apify_api_xyzzy"]'],
    ])('fails without printing the value when the secret %s', (_, packed) => {
        const { status, stdout, stderr } = run({ APIFY_ACTOR_TOKENS: packed });
        expect(status).toBe(1);
        expect(stdout).toContain('::error::The APIFY_ACTOR_TOKENS secret must be a JSON object.');
        expect(stdout + stderr).not.toContain('xyzzy');
    });
});
