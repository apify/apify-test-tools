#!/usr/bin/env node
// Reads changed file paths on stdin (one per line) and fails if a PR changes both a consumer-facing
// workflow and the package code it calls, without raising the floor in workflows-min-package-version.
//
// The case this catches: a workflow starts using a CLI feature from the same PR. On merge the tag
// moves, the workflow goes live, and it calls something that is not on npm yet — breaking every
// consumer's CI at once. Raising the floor instead holds the tag until the release that publishes it.
//
// It deliberately only looks at one PR. A workflow could also start depending on package code that
// landed in an *earlier*, still-unreleased PR, which this will not see — that needs someone to ship
// a breaking CLI change and then sit on it unreleased, and catching it means flagging every workflow
// edit made while any package change is unreleased, which is far more noise than the case is worth.

const PUBLIC_WORKFLOW = /^\.github\/workflows\/public_.*\.ya?ml$/;
// The composite action is consumer-facing too, and it is what installs the package.
const PUBLIC_ACTION = /^\.github\/actions\//;
// What `npx apify-test-tools ...` runs, and the library the platform tests import.
const PACKAGE_CODE = /^(bin\/|lib\/|index\.ts$)/;
const FLOOR_FILE = '.github/workflows-min-package-version';
const OVERRIDE_LABEL = 'no-floor-bump-needed';

const changed = await new Promise((resolve) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buffer += chunk));
    process.stdin.on('end', () =>
        resolve(
            buffer
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean),
        ),
    );
});

const publicSurface = changed.filter((f) => PUBLIC_WORKFLOW.test(f) || PUBLIC_ACTION.test(f));
const packageCode = changed.filter((f) => PACKAGE_CODE.test(f));
const floorBumped = changed.includes(FLOOR_FILE);

if (publicSurface.length === 0 || packageCode.length === 0) {
    console.log('No consumer-facing workflow and package change in the same PR; nothing to check.');
    process.exit(0);
}

if (floorBumped) {
    console.log(`Both sides changed and ${FLOOR_FILE} was raised. The tag will hold until that version ships.`);
    process.exit(0);
}

if (
    (process.env.PR_LABELS ?? '')
        .split(',')
        .map((l) => l.trim())
        .includes(OVERRIDE_LABEL)
) {
    console.log(`Both sides changed without a floor bump, allowed by the "${OVERRIDE_LABEL}" label.`);
    process.exit(0);
}

console.error(`This PR changes consumer-facing workflows and the package code they call:

  workflows: ${publicSurface.join(', ')}
  package:   ${packageCode.join(', ')}

On merge the tag moves and those workflows go live immediately, against whatever is on npm today.
If they rely on anything from the package change in this PR, that is not published yet and every
consumer's CI breaks.

If they do rely on it, raise the version in ${FLOOR_FILE} to the release that will contain it. The
tag is then held until you cut that release, and moves on its own once it is published.

If they do not rely on it — the two changes just happen to be in one PR — add the
"${OVERRIDE_LABEL}" label.`);
process.exit(1);
