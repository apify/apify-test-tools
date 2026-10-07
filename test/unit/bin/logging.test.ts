import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const compilerPath = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));
let cliPath: string;
let buildDir: string;
let gitStubDir: string;
const sha = '1'.repeat(40);

describe('CLI logging', () => {
    beforeAll(async () => {
        buildDir = await mkdtemp(path.join(projectRoot, '.cli-test-'));
        execFileSync(process.execPath, [compilerPath, '--outDir', buildDir], { cwd: projectRoot });
        cliPath = path.join(buildDir, 'bin/main.js');
        await chmod(cliPath, 0o755);
        gitStubDir = await mkdtemp(path.join(os.tmpdir(), 'apify-cli-logging-'));
        const gitStub = path.join(gitStubDir, 'git');
        await writeFile(
            gitStub,
            `#!/bin/sh\nprintf '%s' '${sha}»¦«Test<test@example.com>»¦«Tue, 06 Oct 2026 00:00:00 +0000»¦«feature'\n`,
        );
        await chmod(gitStub, 0o755);
    });

    afterAll(async () => {
        await rm(buildDir, { recursive: true, force: true });
        await rm(gitStubDir, { recursive: true, force: true });
    });

    it.each(['info', 'silent'])('keeps JSON results intact with --log-level %s', (level) => {
        const result = spawnSync(
            cliPath,
            ['get-commits', '--source-branch', 'feature', '--target-branch', 'base', '--log-level', level],
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
