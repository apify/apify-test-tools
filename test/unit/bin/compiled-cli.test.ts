import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const processGroupExists = (pid: number) => {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
        throw error;
    }
};

it.skipIf(process.platform === 'win32').each<NodeJS.Signals>(['SIGINT', 'SIGTERM'])(
    'stops npm and its compiler and removes the build directory on %s',
    async (signal) => {
        const previousDirs = new Set(await readdir(projectRoot));
        let buildDir: string | undefined;
        const child = spawn('npm', ['run', 'test', '--', 'test/unit/bin/build-cli.test.ts', '--maxWorkers=1'], {
            cwd: projectRoot,
            detached: true,
            stdio: 'ignore',
        });
        const closed = new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', () => resolve());
        });
        const { pid } = child;
        if (pid === undefined) throw new Error('Could not start npm');
        const cleanup = () => {
            if (processGroupExists(pid)) process.kill(-pid, 'SIGKILL');
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', interrupt);
            process.off('exit', cleanup);
        };
        const interrupt = (received: NodeJS.Signals) => {
            cleanup();
            process.kill(process.pid, received);
        };
        process.prependOnceListener('SIGINT', interrupt);
        process.prependOnceListener('SIGTERM', interrupt);
        process.prependOnceListener('exit', cleanup);
        try {
            await expect
                .poll(
                    async () => {
                        const name = (await readdir(projectRoot)).find(
                            (dir) => dir.startsWith('.cli-test-') && !previousDirs.has(dir),
                        );
                        buildDir = name && path.join(projectRoot, name);
                        return buildDir;
                    },
                    { timeout: 15_000, interval: 10 },
                )
                .toBeTruthy();
            if (!buildDir) throw new Error('The CLI build directory was not created');
            expect(existsSync(path.join(buildDir, 'bin/main.js'))).toBe(false);
            process.kill(-pid, signal);
            await expect.poll(() => processGroupExists(pid), { timeout: 5_000 }).toBe(false);
            await closed;
            expect(existsSync(buildDir)).toBe(false);
        } finally {
            cleanup();
            await closed;
            if (buildDir) await rm(buildDir, { recursive: true, force: true });
        }
    },
    25_000,
);
