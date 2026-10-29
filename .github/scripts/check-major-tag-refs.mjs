#!/usr/bin/env node
// Fails if any reference to this repo's own reusable workflows or composite actions points at a
// different tag than MAJOR_TAG in _move_major_tag.yaml, or if a workflow loads this repo's composite
// action by name instead of with `$/`.
//
// The tag consumers pin is repeated literally in the commented examples and in the README and docs
// snippets people copy. Bumping the major means editing all of them by hand.
//
// Inside this repo the workflows load the composite action with `uses: $/...`, which resolves to the
// commit the workflow was called at. A `uses: apify/apify-test-tools/...@<ref>` instead runs the
// action and CLI from that ref whatever the caller pinned, so a caller on an older SHA or on a branch
// quietly gets a mismatched CLI. Nothing fails, the behaviour is just wrong.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TAG_SOURCE = '.github/workflows/_move_major_tag.yaml';

// Every place a ref into this repo can appear: live `uses:`, commented examples, README snippets.
const SEARCH_PATHS = ['.github', 'README.md', 'CONTRIBUTING.md', 'docs'];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const expected = read(TAG_SOURCE).match(/^\s*MAJOR_TAG:\s*(\S+)\s*$/m)?.[1];
if (!expected) {
    console.error(`Could not find MAJOR_TAG in ${TAG_SOURCE}.`);
    process.exit(1);
}

const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.statSync(abs).isDirectory()) return [rel];
    return fs.readdirSync(abs).flatMap((entry) => walk(path.join(rel, entry)));
};

const problems = [];

// Self-references, e.g. `uses: apify/apify-test-tools/.github/workflows/public_pr-build-test.yaml@workflows-v0`.
// The ref charset stops at a backtick or quote so a ref quoted in prose isn't captured with its
// punctuation; git refnames cannot end in a dot, so a sentence-final one is trimmed.
const SELF_REF = /apify\/apify-test-tools\/\.github\/\S*?@([A-Za-z0-9._/-]+)/g;
for (const file of SEARCH_PATHS.flatMap(walk)) {
    read(file)
        .split('\n')
        .forEach((line, i) => {
            for (const [match, rawRef] of line.matchAll(SELF_REF)) {
                const ref = rawRef.replace(/\.+$/, '');
                if (ref !== expected) {
                    problems.push(`${file}:${i + 1}: ${match.trim()} — expected @${expected}`);
                }
            }
        });
}

// Live `uses:` lines in this repo's own workflows and actions must load it with `$/`. Commented
// lines are usage examples for callers and are checked against MAJOR_TAG above.
const LIVE_SELF_USES = /^\s*(?:-\s+)?uses:\s*['"]?apify\/apify-test-tools\//;
for (const file of ['.github/workflows', '.github/actions'].flatMap(walk)) {
    read(file)
        .split('\n')
        .forEach((line, i) => {
            if (LIVE_SELF_USES.test(line)) {
                problems.push(`${file}:${i + 1}: ${line.trim()} — load this repo with \`uses: $/<path>\` instead`);
            }
        });
}

if (problems.length > 0) {
    console.error(`These references to this repo need fixing (MAJOR_TAG is ${expected}):\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(`\nUpdate them, or change MAJOR_TAG in ${TAG_SOURCE}.`);
    process.exit(1);
}

console.log(`All references to this repo point at @${expected}, and the workflows load it with $/.`);
