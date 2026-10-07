import process from 'node:process';

// Git exports repository variables to the hooks it runs, and the pre-commit hook runs this suite.
// From a linked worktree that includes GIT_DIR, so a `git init` in a temp dir re-initialises the
// real repository (setting core.bare=true in the shared config) and `git ls-files` reads its index.
// The tests always mean the repo at their cwd, so drop them all. The list is `git rev-parse --local-env-vars`.
const REPO_LOCAL_GIT_ENV_VARS = [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
    'GIT_OBJECT_DIRECTORY',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_GRAFT_FILE',
    'GIT_INDEX_FILE',
    'GIT_NO_REPLACE_OBJECTS',
    'GIT_REPLACE_REF_BASE',
    'GIT_PREFIX',
    'GIT_SHALLOW_FILE',
    'GIT_COMMON_DIR',
];

for (const name of REPO_LOCAL_GIT_ENV_VARS) {
    delete process.env[name];
}
