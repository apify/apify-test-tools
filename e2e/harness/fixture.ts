import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Git, run } from './git.js';
import { branchNames, CALLED_WORKFLOWS, rewriteWorkflow } from './rewrite.js';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_DIR = path.join(REPO_ROOT, 'e2e/fixture');
export const VENDORED_TARBALL = 'vendor/apify-test-tools.tgz';

export const SANDBOX_REPO = 'apify-store/testing-repo-for-github-actions';

/** Where `prepare` builds the sandbox checkout, unless told otherwise. Gitignored. */
export const defaultWorkDir = (runId: string) => path.join(REPO_ROOT, 'e2e/.work', runId);

/**
 * Packs this checkout of apify-test-tools and returns the tarball's path. Built fresh, so the
 * sandbox runs exactly the CLI and library in the working tree.
 */
const packPackage = (outDir: string): string => {
    run('npm', ['run', 'build'], { cwd: REPO_ROOT, quiet: true });
    const [{ filename }] = JSON.parse(
        run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', outDir], {
            cwd: REPO_ROOT,
            quiet: true,
        }),
    ) as { filename: string }[];
    return path.join(outDir, filename);
};

/**
 * Copies what the reusable workflows need at run time into the sandbox checkout, as it sits in this
 * repo: the workflows the fixture calls, the composite action, the scripts it exposes, and the version pin.
 */
const copyWorkflowInfra = (workDir: string, ref: string) => {
    const src = path.join(REPO_ROOT, '.github');
    const dest = path.join(workDir, '.github');

    fs.cpSync(path.join(src, 'actions'), path.join(dest, 'actions'), { recursive: true });
    fs.cpSync(path.join(src, 'scripts'), path.join(dest, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(src, 'workflows-package-version'), path.join(dest, 'workflows-package-version'));

    for (const name of CALLED_WORKFLOWS) {
        const text = fs.readFileSync(path.join(src, 'workflows', name), 'utf8');
        fs.writeFileSync(
            path.join(dest, 'workflows', name),
            rewriteWorkflow(name, text, { sandboxRepo: SANDBOX_REPO, ref }),
        );
    }
};

/**
 * Builds the sandbox checkout for a run: the fixture, this repo's workflows, and this checkout of the
 * package vendored as a tarball, committed as the first commit of the run's base branch.
 *
 * Needs no credentials, so CI runs it in a step that holds none. The only network access is npm
 * resolving the fixture's lockfile.
 */
export const prepareSandbox = ({ runId, workDir }: { runId: string; workDir: string }): Git => {
    const branches = branchNames(runId);

    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.cpSync(FIXTURE_DIR, workDir, {
        recursive: true,
        filter: (source) => !/[\\/](node_modules|storage)([\\/]|$)/.test(path.relative(FIXTURE_DIR, source)),
    });

    copyWorkflowInfra(workDir, branches.base);

    const tarball = packPackage(path.dirname(workDir));
    fs.renameSync(tarball, path.join(workDir, VENDORED_TARBALL));

    // The committed lockfile pins the fixture's other dependencies; this only re-resolves the tarball
    // (whose integrity changes with every build) and whatever the packed package.json now depends on.
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: workDir,
        quiet: true,
    });

    run('git', ['init', '--quiet', '-b', branches.base], { cwd: workDir });
    const git = new Git(workDir);
    const sha = run('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT });
    // [skip ci]: pushing a new branch would otherwise trigger the push workflow with no `before`.
    git.commitAll(`e2e: fixture for apify-test-tools@${sha.slice(0, 12)} [skip ci]`);
    console.error(`Prepared ${branches.base} in ${workDir}`);
    return git;
};
