/* eslint-disable no-console */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The library and the CLI are released together under one version number, so they get the same beta
// suffix too. The setup action relies on that: a repo testing a library beta gets the CLI beta with the
// same version.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG_JSON_PATHS = ['packages/lib/package.json', 'packages/cli/package.json'].map((p) => join(ROOT, p));

const pkgJsons = PKG_JSON_PATHS.map((path) => ({ path, json: JSON.parse(readFileSync(path, 'utf8')) }));

const versions = new Set(pkgJsons.map(({ json }) => json.version));
if (versions.size !== 1) {
    console.error(`before-deploy: Workspace packages disagree on the version: ${[...versions].join(', ')}`);
    process.exit(1);
}
const [VERSION] = versions;

const published = pkgJsons.flatMap(({ json }) => publishedVersions(json.name));
const nextVersion = addBetaSuffixToVersion(VERSION, published);
console.log(`before-deploy: Setting version to ${nextVersion}`);

for (const { path, json } of pkgJsons) {
    json.version = nextVersion;
    writeFileSync(path, `${JSON.stringify(json, null, 4)}\n`);
}

function publishedVersions(packageName) {
    let versionString;
    try {
        versionString = execSync(`npm show ${packageName} versions --json`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        // A package that was never published has no versions to collide with.
        if (String(err.stderr).includes('E404')) return [];
        throw err;
    }
    // Normalize npm's output: npm 12 wraps the versions in an extra array ([[...]]),
    // and npm returns a bare string for packages with a single published version.
    return [JSON.parse(versionString)].flat(Infinity).filter((v) => typeof v === 'string');
}

function addBetaSuffixToVersion(version, publishedList) {
    if (publishedList.some((v) => v === version)) {
        console.error(
            `before-deploy: A release with version ${version} already exists. Please increment version accordingly.`,
        );
        process.exit(1);
    }

    // Counted across both packages, so the next beta number is free in each of them.
    const prereleaseNumbers = publishedList
        .filter((v) => v.startsWith(version) && v.includes('-'))
        .map((v) => Number(v.match(/\.(\d+)$/)[1]));
    const lastPrereleaseNumber = Math.max(-1, ...prereleaseNumbers);
    return `${version}-beta.${lastPrereleaseNumber + 1}`;
}
