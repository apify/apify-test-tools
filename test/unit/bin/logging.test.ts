import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('../../../bin/main.ts', import.meta.url));
let gitStubDir: string;
const sha = '1'.repeat(40);

describe('CLI logging', () => {
    beforeAll(async () => {
        gitStubDir = await mkdtemp(path.join(os.tmpdir(), 'apify-cli-logging-'));
        const gitStub = path.join(gitStubDir, 'git');
        await writeFile(
            gitStub,
            `#!/bin/sh\nprintf '%s' '${sha}»¦«Test<test@example.com>»¦«Tue, 06 Oct 2026 00:00:00 +0000»¦«feature'\n`,
        );
        await chmod(gitStub, 0o755);
    });

    afterAll(async () => {
        await rm(gitStubDir, { recursive: true, force: true });
    });

    it.each(['info', 'silent'])('keeps JSON results intact with --log-level %s', (level) => {
        const result = spawnSync(
            process.execPath,
            [
                '--import',
                'tsx',
                cliPath,
                'get-commits',
                '--source-branch',
                'feature',
                '--target-branch',
                'base',
                '--log-level',
                level,
            ],
            {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, PATH: `${gitStubDir}${path.delimiter}${process.env.PATH ?? ''}` },
            },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toEqual(level === 'silent' ? '' : expect.stringContaining('Commits being returned:'));
        expect(JSON.parse(result.stdout)).toMatchObject([{ sha, date: expect.any(String), message: 'feature' }]);
        expect(result.stdout.endsWith('\n')).toBe(true);
    });
});
