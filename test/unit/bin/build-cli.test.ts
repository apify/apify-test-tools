import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const compilerPath = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));
let cliPath: string;
let buildDir: string | undefined;

const runBuild = (input: string, args: string[] = []) =>
    spawnSync(cliPath, ['build', ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

describe('build CLI', () => {
    beforeAll(async () => {
        buildDir = await mkdtemp(path.join(projectRoot, '.cli-test-'));
        execFileSync(process.execPath, [compilerPath, '--outDir', buildDir], { cwd: projectRoot });
        cliPath = path.join(buildDir, 'bin/main.js');
        await chmod(cliPath, 0o755);
    });

    afterAll(async () => {
        if (buildDir) await rm(buildDir, { recursive: true, force: true });
    });

    it('builds nothing for an empty list and prints an empty build list', () => {
        const result = runBuild('{"actors":[]}');
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toStrictEqual([]);
    });

    it('fails on empty stdin instead of building nothing', () => {
        const result = runBuild('');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Expected the Actors to build as JSON on stdin, got nothing');
        expect(result.stdout).toBe('');
    });

    it('rejects a malformed --version-number', () => {
        const result = runBuild('{"actors":[]}', ['--version-number', 'latest']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('--version-number must look like 0.99 or be "default"');
    });
});
