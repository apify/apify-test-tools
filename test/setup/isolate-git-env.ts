import process from 'node:process';

// Git hooks run from a linked worktree export GIT_DIR, which would point the tests' `git init` at the
// real repository (setting core.bare=true). The tests always mean the repo at their cwd.
for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) delete process.env[name];
}
