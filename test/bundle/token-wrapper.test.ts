import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const wrapperPath = fileURLToPath(new URL('../../.github/scripts/run-with-apify-tokens.mjs', import.meta.url));
const configFileName = 'apify-test-tools.config.json';

let repoDir: string;

describe('token wrapper bundle', () => {
    beforeAll(async () => {
        repoDir = await mkdtemp(path.join(os.tmpdir(), 'apify-token-wrapper-'));
    });

    afterAll(async () => {
        if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    const actorSecrets = {
        GROUP_TOKEN: 'group-value',
        OVERRIDE_TOKEN: 'override-value',
        OTHER: 'hidden',
    };

    const runWrapper = (configSecrets: Record<string, string> = actorSecrets) =>
        spawnSync(
            process.execPath,
            [wrapperPath, '--tokens', 'build', process.execPath, '-e', 'console.log(JSON.stringify(process.env))'],
            {
                cwd: repoDir,
                env: {
                    PATH: process.env.PATH ?? '',
                    CONFIG_SECRETS: JSON.stringify(configSecrets),
                },
                encoding: 'utf8',
            },
        );

    it('passes grouped tokens and actor overrides from CONFIG_SECRETS without unrelated secrets', async () => {
        await writeFile(
            path.join(repoDir, configFileName),
            JSON.stringify({
                mode: 'grouped',
                groups: {
                    example: {
                        buildTokenEnvVar: 'GROUP_TOKEN',
                        testTokenEnvVar: 'GROUP_TOKEN',
                        actors: [
                            { folder: 'actors/one', actorFullName: 'example/one' },
                            {
                                folder: 'actors/two',
                                actorFullName: 'example/two',
                                buildTokenEnvVar: 'OVERRIDE_TOKEN',
                            },
                        ],
                    },
                },
            }),
        );

        const { status, stdout, stderr } = runWrapper();
        expect(status, stderr).toBe(0);
        const childEnv: Record<string, string> = JSON.parse(stdout);
        expect(childEnv).toMatchObject({ GROUP_TOKEN: 'group-value', OVERRIDE_TOKEN: 'override-value' });
        expect(childEnv).not.toHaveProperty('OTHER');
        expect(childEnv).not.toHaveProperty('CONFIG_SECRETS');
        expect(stderr).toContain('Passing 2 build token(s)');
    });

    it('does not start the child when config validation fails', async () => {
        await writeFile(path.join(repoDir, configFileName), JSON.stringify({ mode: 'grouped', groups: {} }));

        const { status, stdout, stderr } = runWrapper();
        expect(status).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toContain('At least one configuration group is required');
        expect(stderr).not.toContain('Cannot read');
    });

    it.each(['', undefined])(
        'rejects an empty or missing token name (%s) before starting the child',
        async (buildTokenEnvVar) => {
            await writeFile(
                path.join(repoDir, configFileName),
                JSON.stringify({
                    mode: 'grouped',
                    groups: {
                        example: {
                            buildTokenEnvVar,
                            testTokenEnvVar: 'TEST_TOKEN',
                            actors: [{ folder: 'actors/one', actorFullName: 'example/one' }],
                        },
                    },
                }),
            );

            const { status, stdout, stderr } = runWrapper();
            expect(status).toBe(1);
            expect(stdout).toBe('');
            expect(stderr).toContain('groups.example.buildTokenEnvVar');
            expect(stderr).not.toContain('Warning:');
            expect(stderr).not.toContain('Cannot read');
        },
    );

    it('reports a missing config file without a duplicate error prefix', async () => {
        await rm(path.join(repoDir, configFileName), { force: true });

        const { status, stdout, stderr } = runWrapper();
        expect(status).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toBe(
            `Config file "${configFileName}" not found in the current directory. ` +
                'Please create one with the required actor entries.\n',
        );
    });
});
