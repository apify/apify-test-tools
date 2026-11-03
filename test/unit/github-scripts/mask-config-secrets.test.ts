import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../.github/scripts/mask-config-secrets.sh', import.meta.url));

const run = (configSecrets?: string) =>
    spawnSync('bash', [SCRIPT], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ...(configSecrets === undefined ? {} : { CONFIG_SECRETS: configSecrets }) },
    });

const masks = (stdout: string) => stdout.split('\n').filter((line) => line !== '');

describe('mask-config-secrets.sh', () => {
    it('registers every value as a mask', () => {
        const { status, stdout, stderr } = run(JSON.stringify({ TOKEN_ONE: 'one', TOKEN_TWO: 'two' }));
        expect(status, stderr).toBe(0);
        expect(masks(stdout)).toStrictEqual(['::add-mask::one', '::add-mask::two']);
    });

    it('registers a multi-line value line by line, skipping empty lines', () => {
        const { status, stdout, stderr } = run(
            JSON.stringify({ DEPLOY_KEY: '-----BEGIN KEY-----\nabc\n\n-----END KEY-----\n' }),
        );
        expect(status, stderr).toBe(0);
        expect(masks(stdout)).toStrictEqual([
            '::add-mask::-----BEGIN KEY-----',
            '::add-mask::abc',
            '::add-mask::-----END KEY-----',
        ]);
    });

    it('skips values that are not strings', () => {
        const { status, stdout, stderr } = run(JSON.stringify({ TOKEN_ONE: 'one', COUNT: 1 }));
        expect(status, stderr).toBe(0);
        expect(masks(stdout)).toStrictEqual(['::add-mask::one']);
    });

    it.each([
        ['is unset', undefined],
        ['is empty', ''],
    ])('does nothing when CONFIG_SECRETS %s', (_, configSecrets) => {
        const { status, stdout, stderr } = run(configSecrets);
        expect(status, stderr).toBe(0);
        expect(stdout).toBe('');
    });

    it.each([
        ['is not JSON', 'apify_api_xyzzy'],
        ['is a JSON string', '"apify_api_xyzzy"'],
        ['is a JSON array', '["apify_api_xyzzy"]'],
    ])('fails without printing the value when the secret %s', (_, configSecrets) => {
        const { status, stdout, stderr } = run(configSecrets);
        expect(status).toBe(1);
        expect(stdout).toContain('::error::The CONFIG_SECRETS secret must be a JSON object.');
        expect(stdout + stderr).not.toContain('xyzzy');
    });
});
