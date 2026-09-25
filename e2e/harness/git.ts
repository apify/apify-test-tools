import { spawnSync } from 'node:child_process';

/** The secrets the harness reads. Documented in e2e/README.md. */
export const SECRET_ENV_VARS = ['SANDBOX_GITHUB_TOKEN', 'E2E_APIFY_TOKEN', 'E2E_TESTER_APIFY_TOKEN'] as const;

/**
 * Environment for child processes, minus the harness's own secrets, so that npm, git and the CLI
 * under test never see the Apify or GitHub tokens. The GitHub token reaches git only as the
 * auth header of the sandbox remote (see githubAuthEnv).
 */
export const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    for (const name of SECRET_ENV_VARS) delete env[name];
    return { ...env, ...extra };
};

export const run = (
    command: string,
    args: string[],
    { cwd, env = childEnv(), quiet = false }: { cwd: string; env?: NodeJS.ProcessEnv; quiet?: boolean },
): string => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`\`${command} ${args.join(' ')}\` failed:\n${result.stderr}`);
    }
    if (!quiet && result.stderr.trim()) console.error(result.stderr.trim());
    return result.stdout.trim();
};

const COMMITTER = ['-c', 'user.name=apify-test-tools e2e', '-c', 'user.email=e2e@apify-test-tools.invalid'];

export class Git {
    constructor(
        readonly dir: string,
        /** Extra environment for git, e.g. the auth header for the sandbox remote. */
        private readonly env: Record<string, string> = {},
    ) {}

    exec = (...args: string[]) =>
        run('git', [...COMMITTER, ...args], {
            cwd: this.dir,
            env: childEnv({ GIT_TERMINAL_PROMPT: '0', ...this.env }),
            quiet: true,
        });

    commitAll = (message: string): string => {
        this.exec('add', '-A');
        this.exec('commit', '--quiet', '-m', message);
        return this.exec('rev-parse', 'HEAD');
    };

    push = (localRef: string, remoteBranch: string) =>
        this.exec('push', '--quiet', 'origin', `${localRef}:refs/heads/${remoteBranch}`);

    /** Checks out `branch` at the tip of the remote's `remoteBranch`. */
    checkoutFromRemote = (branch: string, remoteBranch: string): string => {
        this.exec('fetch', '--quiet', 'origin', `+refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`);
        this.exec('checkout', '--quiet', '-B', branch, `origin/${remoteBranch}`);
        return this.exec('rev-parse', 'HEAD');
    };
}

/**
 * Git config, as environment, that authenticates HTTPS requests to github.com the way
 * actions/checkout does. Environment rather than `-c` so the token stays out of the process list.
 */
export const githubAuthEnv = (token: string): Record<string, string> => ({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
});
