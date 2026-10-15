#!/usr/bin/env bash
# Installs the apify-test-tools CLI the workflows call into <dir>, without resolving anything:
# the dependencies come from .github/cli/package-lock.json and the package itself is the exact
# published version. Used by the composite action, and by this repo's CI to prove the committed
# lockfile still fits the version the workflows pin.
#
#     install-cli.sh <version> <dir>
#
# Puts the executable at <dir>/bin/apify-test-tools.
set -euo pipefail

version=$1
dir=$2
lock_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../cli" && pwd)"

mkdir -p "$dir"
cp "$lock_dir/package.json" "$lock_dir/package-lock.json" "$dir/"
# npm reads the project .npmrc from the install prefix, so a repo that routes everything through
# a private registry needs its own copied in. Removed again below so it never lands in a cache.
if [ -f .npmrc ]; then cp .npmrc "$dir/.npmrc"; fi
trap 'rm -f "$dir/.npmrc"' EXIT

# Scripts are off: none of the runtime dependencies need them, and they are how a compromised
# package would run code during install.
npm ci --prefix "$dir" --omit=peer --ignore-scripts --no-audit --no-fund

# The package on its own, without its dependencies. npm checks the tarball against the integrity
# the registry lists for this exact version. The pin is published by the release that pins it, so
# it is exempt from any min-release-age the repo's .npmrc sets.
tarball=$(npm pack "apify-test-tools@$version" --pack-destination "$dir" --ignore-scripts \
    --min-release-age-exclude=apify-test-tools --json | jq -r '.[0].filename')
mkdir -p "$dir/node_modules/apify-test-tools"
tar -xzf "$dir/$tarball" -C "$dir/node_modules/apify-test-tools" --strip-components=1
rm "$dir/$tarball"

# Declaring it lets npm ls check its dependency ranges against what the lockfile installed. The
# lockfile follows this repo's package.json, which can move ahead of the pinned version, so this
# is what catches a lockfile that no longer fits it.
(
    cd "$dir"
    APIFY_TEST_TOOLS_VERSION="$version" node --input-type=module <<'EOF'
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.dependencies['apify-test-tools'] = process.env.APIFY_TEST_TOOLS_VERSION;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 4));

let report;
try {
    report = execFileSync('npm', ['ls', '--all', '--omit=peer', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (error) {
    // npm ls exits non-zero whenever it lists a problem; the JSON is still on stdout.
    report = error.stdout;
}

// npm ls lists peers as missing even with --omit=peer. The CLI never loads its peers (vitest).
const { peerDependencies = {} } = JSON.parse(fs.readFileSync('node_modules/apify-test-tools/package.json', 'utf8'));
const peerMissing = (problem) =>
    Object.keys(peerDependencies).some((peer) => problem.startsWith(`missing: ${peer}@`) && problem.includes('required by apify-test-tools@'));
const problems = (JSON.parse(report).problems ?? []).filter((problem) => !peerMissing(problem));

if (problems.length > 0) {
    console.error(`.github/cli/package-lock.json does not satisfy apify-test-tools@${process.env.APIFY_TEST_TOOLS_VERSION}:`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
}
EOF
)

mkdir -p "$dir/bin"
chmod +x "$dir/node_modules/apify-test-tools/dist/bin/main.js"
ln -sf ../node_modules/apify-test-tools/dist/bin/main.js "$dir/bin/apify-test-tools"
echo "Installed apify-test-tools@$version CLI into $dir"
