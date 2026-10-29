import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { describe, expect, inject, it } from 'vitest';

const cliPath = inject('cliPath');

const run = (command: string[], input: string, env: NodeJS.ProcessEnv = process.env) =>
    spawnSync(cliPath, command, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env });
const runBuild = (input: string, args: string[] = ['--version-number', '0.99']) => run(['build', ...args], input);

describe('build and notify-release CLI', () => {
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
        expect(result.stderr).toContain('--version-number must look like 0.1 or be "default"');
    });

    it('requires --version-number', () => {
        const result = runBuild('{"actors":[]}', []);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Missing required argument: version-number');
    });

    it('notify-release announces nothing when there are no new commits', () => {
        const document = { commits: [], changedFiles: [], changelog: null, functionallyChangedActors: [] };
        const result = run(['notify-release'], JSON.stringify(document));
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain('No new commits, so there is no release to announce');
    });
});
