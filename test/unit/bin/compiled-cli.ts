import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { chmod, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// eslint-disable-next-line import/extensions -- Vitest exports this subpath without a file extension.
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
    interface ProvidedContext {
        cliPath: string;
    }
}

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const compilerPath = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));

/** Compiles once in Vitest's main process so workers share the build and cancellation can clean it up. */
export const setup = async (project: TestProject) => {
    const buildDir = await mkdtemp(path.join(projectRoot, '.cli-test-'));
    const compilation = promisify(execFile)(
        process.execPath,
        [compilerPath, '--project', 'test/tsconfig.cli.json', '--outDir', buildDir],
        { cwd: projectRoot },
    );
    const cleanup = () => {
        compilation.child.kill('SIGKILL');
        rmSync(buildDir, { recursive: true, force: true });
        process.off('SIGINT', cleanup);
        process.off('SIGTERM', cleanup);
        process.off('exit', cleanup);
    };
    // Clean up synchronously before Vitest's signal handlers exit the process.
    process.prependOnceListener('SIGINT', cleanup);
    process.prependOnceListener('SIGTERM', cleanup);
    process.prependOnceListener('exit', cleanup);
    try {
        await compilation;
        const cliPath = path.join(buildDir, 'bin/main.js');
        await chmod(cliPath, 0o755);
        project.provide('cliPath', cliPath);
        return cleanup;
    } catch (error) {
        cleanup();
        throw error;
    }
};
