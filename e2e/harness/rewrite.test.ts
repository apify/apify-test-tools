import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { applyMutation, branchNames, CALLED_WORKFLOWS, rewriteWorkflow } from './rewrite.js';
import { buildScenarios } from './scenarios.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const options = { sandboxRepo: 'owner/sandbox', ref: 'e2e/1/base' };

describe('rewriteWorkflow', () => {
    test('points self-references at the sandbox copy, whatever ref they had', () => {
        const text = [
            'uses: apify/apify-test-tools/.github/actions/checkout-restore-dependencies@workflows-v0',
            'uses: apify/apify-test-tools/.github/actions/checkout-restore-dependencies@some/branch',
            'uses: actions/checkout@v6',
        ].join('\n');

        expect(rewriteWorkflow('public_pr-build-test.yaml', text, options)).toBe(
            [
                'uses: owner/sandbox/.github/actions/checkout-restore-dependencies@e2e/1/base',
                'uses: owner/sandbox/.github/actions/checkout-restore-dependencies@e2e/1/base',
                'uses: actions/checkout@v6',
            ].join('\n'),
        );
    });

    test('fails when a called workflow stops loading the composite action the known way', () => {
        expect(() => rewriteWorkflow('public_pr-build-test.yaml', 'uses: actions/checkout@v6', options)).toThrow(
            /no longer references/,
        );
    });

    test('fails when the default-branch guard of the scheduled tests changes', () => {
        const text = 'uses: apify/apify-test-tools/.github/actions/x@workflows-v0\nif: github.ref_name == "master"';
        expect(() => rewriteWorkflow('public_platform-tests.yaml', text, options)).toThrow(/default-branch guard/);
    });

    // The same checks against the files the harness will actually copy, so a workflow edit that
    // would break the sandbox run fails here first.
    test.each(CALLED_WORKFLOWS)('rewrites the real %s', (name) => {
        const text = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows', name), 'utf8');
        const rewritten = rewriteWorkflow(name, text, options);

        expect(rewritten).not.toMatch(/apify\/apify-test-tools\/\.github/);
        expect(rewritten).toContain('owner/sandbox/.github/actions/checkout-restore-dependencies@e2e/1/base');
        if (name === 'public_platform-tests.yaml') {
            expect(rewritten).toContain("if: github.ref == 'refs/heads/e2e/1/base'");
        }
    });
});

describe('applyMutation', () => {
    test('appends', () => {
        expect(applyMutation('a\n', { file: 'f', append: 'b\n' })).toBe('a\nb\n');
    });

    test('replaces an exact, unique match', () => {
        expect(applyMutation('x $& y', { file: 'f', replace: { from: 'x', to: '$&' } })).toBe('$& $& y');
    });

    test('refuses a replacement that matches zero or several times', () => {
        expect(() => applyMutation('a a', { file: 'f', replace: { from: 'a', to: 'b' } })).toThrow(/2 times/);
        expect(() => applyMutation('a', { file: 'f', replace: { from: 'z', to: 'b' } })).toThrow(/0 times/);
    });
});

describe('scenarios', () => {
    // Every replace mutation must hit the fixture as it is when its step runs, i.e. after the
    // earlier steps of the same scenario.
    test('edit files that exist in the fixture, and each replacement matches', () => {
        for (const scenario of buildScenarios('test')) {
            if (scenario.kind !== 'pull-request') continue;
            const files = new Map<string, string>();
            for (const step of scenario.steps) {
                for (const mutation of step.mutations) {
                    const current =
                        files.get(mutation.file) ??
                        fs.readFileSync(path.join(REPO_ROOT, 'e2e/fixture', mutation.file), 'utf8');
                    files.set(mutation.file, applyMutation(current, mutation));
                }
            }
        }
    });

    test('only use scenario names that are valid branch name segments', () => {
        const { head } = branchNames('run-1');
        for (const { name } of buildScenarios('run-1')) {
            expect(head(name)).toMatch(/^e2e\/run-1\/[a-z0-9-]+$/);
        }
    });
});

describe('branchNames', () => {
    test('rejects run ids that would change the branch layout', () => {
        expect(() => branchNames('a/b')).toThrow();
        expect(branchNames('123-1').base).toBe('e2e/123-1/base');
    });
});
