import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import/extensions --- a package subpath export, not a file
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
    export interface ProvidedContext {
        /** The CLI compiled from the sources, read in tests with `inject('cliPath')`. */
        cliPath: string;
    }
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const compilerPath = path.join(projectRoot, 'node_modules/typescript/bin/tsc');

let buildDir: string | undefined;

export const teardown = async () => {
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
};

/**
 * Compiles the CLI from the sources once per test run, so tests run it the way users do.
 *
 * The build goes under node_modules/.cache: inside the project, so the compiled CLI resolves its
 * dependencies from node_modules, and out of vitest's way, so the compiled copies of the tests are
 * never collected even if a killed run leaves them behind.
 */
export const setup = async (project: TestProject) => {
    const cacheDir = path.join(projectRoot, 'node_modules/.cache');
    await mkdir(cacheDir, { recursive: true });
    buildDir = await mkdtemp(path.join(cacheDir, 'cli-test-'));
    try {
        execFileSync(process.execPath, [compilerPath, '--outDir', buildDir], { cwd: projectRoot });
        const cliPath = path.join(buildDir, 'bin/main.js');
        await chmod(cliPath, 0o755);
        project.provide('cliPath', cliPath);
    } catch (error) {
        await teardown();
        throw error;
    }
};
