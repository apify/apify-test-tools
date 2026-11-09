import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Finds the vitest the repository installed, the way Node would resolve it from `cwd`. The CLI ships as a bundle
 * that runs outside the repository's `node_modules`, so the tests keep the vitest (and the lib) version the
 * repository locked. Read from `package.json` because vitest's exports don't expose its bin.
 */
export const resolveVitestBin = async (cwd: string): Promise<string> => {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
        const packageDir = path.join(dir, 'node_modules', 'vitest');
        if (existsSync(path.join(packageDir, 'package.json'))) {
            const { bin } = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
            return path.join(packageDir, typeof bin === 'string' ? bin : bin.vitest);
        }
        if (path.dirname(dir) === dir) {
            throw new Error(`vitest is not installed in ${cwd}, install the repository's dependencies first`);
        }
    }
};
