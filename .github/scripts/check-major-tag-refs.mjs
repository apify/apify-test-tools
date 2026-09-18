#!/usr/bin/env node
// Fails if any reference to this repo's own reusable workflows or composite actions points at a
// different tag than MAJOR_TAG in _move_major_tag.yaml.
//
// `uses:` cannot take an expression ("You cannot use contexts or expressions in this keyword"), so
// the tag consumers pin is repeated literally in every self-reference, in the commented examples,
// and in the README snippets people copy. Bumping the major means editing all of them by hand.
//
// Missing one is quiet in the worst case: right after a bump both the old and new tags exist, so a
// workflow called at the new tag happily pulls the composite action from the old one and runs a
// stale version of it. Nothing fails, the behaviour is just wrong.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TAG_SOURCE = '.github/workflows/_move_major_tag.yaml';
const REVIEW_WORKFLOW = '.github/workflows/public_review.yaml';

// Every place a ref into this repo can appear: live `uses:`, commented examples, README snippets.
const SEARCH_PATHS = ['.github', 'README.md', 'CONTRIBUTING.md'];

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

// Self-references, e.g. `uses: apify/apify-test-tools/.github/workflows/public_pr-build-test.yaml@v0`.
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

// review.yaml fetches its prompt from this repo by ref rather than by `uses:`, so it drifts the
// same way: released workflows would read instructions from some other commit.
const promptRef = read(REVIEW_WORKFLOW).match(/prompt-ref:\s*\n\s*default:\s*(\S+)/)?.[1];
if (!promptRef) {
    problems.push(`${REVIEW_WORKFLOW}: could not read the prompt-ref default.`);
} else if (promptRef !== expected) {
    problems.push(`${REVIEW_WORKFLOW}: prompt-ref default is ${promptRef} — expected ${expected}`);
}

if (problems.length > 0) {
    console.error(`MAJOR_TAG is ${expected}, but these disagree:\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(`\nUpdate them, or change MAJOR_TAG in ${TAG_SOURCE}.`);
    process.exit(1);
}

console.log(`All references to this repo point at @${expected}.`);
