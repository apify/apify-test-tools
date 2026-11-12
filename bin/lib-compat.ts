import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The oldest version of the apify-test-tools lib that `test` works with. The CLI ships separately from the lib, so a
 * repository can run the newest CLI with an old lib, and a mismatch in what they pass each other skips every test while
 * the run still passes. `test` refuses an older lib instead. Raising it is a breaking change of the workflows, see
 * CONTRIBUTING.md.
 */
export const OLDEST_SUPPORTED_LIB_VERSION = '1.0.0';

const parseVersion = (version: string) => version.split(/[.-]/, 3).map((part) => Number.parseInt(part, 10) || 0);

/** Whether `version` is older than `than`, comparing major, minor and patch. Pre-release tags are ignored. */
export const isOlderVersion = (version: string, than: string): boolean => {
    const [a, b] = [parseVersion(version), parseVersion(than)];
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
};

/**
 * The version of the lib the repository installed, found the way Node would resolve `apify-test-tools` from `cwd`.
 * Undefined when it isn't installed, e.g. when the tests import it by path.
 */
export const findInstalledLibVersion = async (cwd: string): Promise<string | undefined> => {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
        const packageJson = path.join(dir, 'node_modules', 'apify-test-tools', 'package.json');
        if (existsSync(packageJson)) return JSON.parse(await fs.readFile(packageJson, 'utf8')).version;
        if (path.dirname(dir) === dir) return undefined;
    }
};

/**
 * Throws when the repository installed a lib older than `OLDEST_SUPPORTED_LIB_VERSION`. A lib that isn't installed,
 * e.g. one the tests import by path, passes.
 */
export const assertSupportedLib = async (cwd: string): Promise<void> => {
    const version = await findInstalledLibVersion(cwd);
    if (version && isOlderVersion(version, OLDEST_SUPPORTED_LIB_VERSION)) {
        throw new Error(
            `The repository uses apify-test-tools ${version}, older than ${OLDEST_SUPPORTED_LIB_VERSION}, the oldest ` +
                'version this CLI supports. Update apify-test-tools in package.json.',
        );
    }
};
