import { chmod, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Bundles the current CLI sources into a temporary directory with the settings used by `npm run bundle`. */
export const compileCli = async () => {
    const buildDir = await mkdtemp(path.join(projectRoot, '.cli-test-'));
    const cleanup = async () => rm(buildDir, { recursive: true, force: true });
    try {
        const cliPath = path.join(buildDir, 'apify-test-tools.mjs');
        await build({
            entryPoints: [path.join(projectRoot, 'bin/main.ts')],
            bundle: true,
            minify: true,
            platform: 'node',
            format: 'esm',
            target: 'node24',
            logLevel: 'warning',
            banner: {
                js: "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);",
            },
            outfile: cliPath,
        });
        await chmod(cliPath, 0o755);
        return { cliPath, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
};
