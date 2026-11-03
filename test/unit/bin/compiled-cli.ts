import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const compilerPath = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));

/** Compiles the CLI from the sources into a temporary directory, so tests run it the way npm users do. */
export const compileCli = async () => {
    const buildDir = await mkdtemp(path.join(projectRoot, '.cli-test-'));
    const cleanup = async () => rm(buildDir, { recursive: true, force: true });
    try {
        execFileSync(process.execPath, [compilerPath, '--outDir', buildDir], { cwd: projectRoot });
        const cliPath = path.join(buildDir, 'bin/main.js');
        await chmod(cliPath, 0o755);
        return { cliPath, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
};
