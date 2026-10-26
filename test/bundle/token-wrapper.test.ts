import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
        for (const name of ['one', 'two']) {
            await mkdir(path.join(repoDir, 'actors', name), { recursive: true });
        }
    });

    afterAll(async () => {
        if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    const runWrapper = () =>
        spawnSync(process.execPath, [wrapperPath, process.execPath, '-e', 'console.log(JSON.stringify(process.env))'], {
            cwd: repoDir,
            env: {
                PATH: process.env.PATH ?? '',
                ALL_SECRETS: JSON.stringify({
                    GROUP_TOKEN: 'group-value',
                    OVERRIDE_TOKEN: 'override-value',
                    OTHER: 'hidden',
                }),
            },
            encoding: 'utf8',
        });

    it('passes inherited and overridden grouped tokens without unrelated secrets', async () => {
        await writeFile(
            path.join(repoDir, configFileName),
            JSON.stringify({
                mode: 'grouped',
                groups: {
                    example: {
                        tokenEnvVar: 'GROUP_TOKEN',
                        actors: [
                            { folder: 'actors/one', actorFullName: 'example/one' },
                            { folder: 'actors/two', actorFullName: 'example/two', tokenEnvVar: 'OVERRIDE_TOKEN' },
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
        expect(childEnv).not.toHaveProperty('ALL_SECRETS');
        expect(stderr).toContain('Passing 2 Actor token(s)');
    });

    it('does not start the child when config validation fails', async () => {
        await writeFile(path.join(repoDir, configFileName), JSON.stringify({ mode: 'grouped', groups: {} }));

        const { status, stdout, stderr } = runWrapper();
        expect(status).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toContain('At least one configuration group is required');
    });
});
