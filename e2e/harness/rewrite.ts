import fs from 'node:fs';
import path from 'node:path';

import type { Mutation } from './scenarios.js';

/**
 * Pure text transforms the harness applies to the fixture. Kept apart from anything that touches
 * git or the network so they can be unit tested.
 */

// Any ref, not only the major tag: a branch that temporarily repoints the composite action (as the
// README suggests for testing it) must still end up testing this checkout's copy.
const SELF_REF = /apify\/apify-test-tools\/(\.github\/[^@\s'"`]+)@[A-Za-z0-9._/-]+/g;

// Scheduled tests refuse to run anywhere but the default branch, and the sandbox runs on an
// ephemeral one. This is the only change to workflow logic the harness makes, and it has to match
// exactly, so editing the guard fails here instead of silently testing something else.
const DEFAULT_BRANCH_GUARD = "if: github.ref == 'refs/heads/master' || github.ref == 'refs/heads/main'";

/** The reusable workflows the fixture calls. Each must reference the composite action. */
export const CALLED_WORKFLOWS = [
    'public_pr-build-test.yaml',
    'public_push-build-latest.yaml',
    'public_platform-tests.yaml',
] as const;

type RewriteOptions = {
    /** `owner/name` of the sandbox repo the copy is pushed to. */
    sandboxRepo: string;
    /** Branch of the sandbox repo that holds the copied composite action. */
    ref: string;
};

/**
 * Points a copy of one of this repo's reusable workflows at the composite action copied next to it,
 * instead of the released one at `@workflows-v0`. `uses:` takes no expressions, so the only way to
 * test an unreleased composite action through the workflows is to rewrite the ref.
 */
export const rewriteWorkflow = (fileName: string, text: string, { sandboxRepo, ref }: RewriteOptions): string => {
    let selfRefs = 0;
    let rewritten = text.replace(SELF_REF, (_match, subPath: string) => {
        selfRefs++;
        return `${sandboxRepo}/${subPath}@${ref}`;
    });

    if ((CALLED_WORKFLOWS as readonly string[]).includes(fileName) && selfRefs === 0) {
        throw new Error(
            `${fileName} no longer references apify/apify-test-tools/.github/...; ` +
                `update the e2e harness (e2e/harness/rewrite.ts) to match how it loads the composite action.`,
        );
    }

    if (fileName === 'public_platform-tests.yaml') {
        const occurrences = rewritten.split(DEFAULT_BRANCH_GUARD).length - 1;
        if (occurrences !== 1) {
            throw new Error(
                `Expected the default-branch guard exactly once in ${fileName}, found it ${occurrences} times. ` +
                    `Update DEFAULT_BRANCH_GUARD in e2e/harness/rewrite.ts.`,
            );
        }
        rewritten = rewritten.replace(DEFAULT_BRANCH_GUARD, `if: github.ref == 'refs/heads/${ref}'`);
    }

    return rewritten;
};

export const applyMutation = (text: string, mutation: Mutation): string => {
    if ('append' in mutation) {
        return text + mutation.append;
    }

    const { from, to } = mutation.replace;
    const occurrences = text.split(from).length - 1;
    if (occurrences !== 1) {
        throw new Error(`Expected "${from}" exactly once in ${mutation.file}, found it ${occurrences} times.`);
    }
    return text.replace(from, () => to);
};

export const applyMutations = (repoDir: string, mutations: Mutation[]): void => {
    for (const mutation of mutations) {
        const filePath = path.join(repoDir, mutation.file);
        fs.writeFileSync(filePath, applyMutation(fs.readFileSync(filePath, 'utf8'), mutation));
    }
};

/**
 * Branch names for one run. `e2e/<id>/...` keeps every run's branches together for cleanup. The
 * fixture's workflows trigger on base branches only (`e2e/<id>/base`), never on the PR branches.
 */
export const branchNames = (runId: string) => {
    if (!/^[A-Za-z0-9-]+$/.test(runId)) {
        throw new Error(`Run id "${runId}" must be letters, digits and dashes only; it becomes a branch name segment.`);
    }
    return {
        prefix: `e2e/${runId}/`,
        base: `e2e/${runId}/base`,
        head: (scenarioName: string) => `e2e/${runId}/${scenarioName}`,
    };
};
