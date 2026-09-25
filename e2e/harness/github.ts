import AdmZip from 'adm-zip';

/**
 * The few GitHub REST calls the harness needs, on plain fetch. Scoped to a single repo.
 */

export type WorkflowRun = {
    id: number;
    html_url: string;
    head_sha: string;
    head_branch: string;
    event: string;
    /** The triggering workflow file, e.g. `.github/workflows/pr-build-test.yaml`. */
    path: string;
    status: string;
    conclusion: string | null;
    created_at: string;
};

export type Job = { name: string; status: string; conclusion: string | null; html_url: string };

const POLL_INTERVAL_MS = 15_000;
// How long a triggered workflow may take to show up in the API before we call it "never triggered".
const RUN_APPEAR_TIMEOUT_MS = 5 * 60_000;
// Longer than any single sandbox workflow should take, well within the job timeout.
const RUN_FINISH_TIMEOUT_MS = 45 * 60_000;

const MAX_ATTEMPTS = 4;

/** An error response from the API, with its status for callers that handle one specifically. */
const apiError = (method: string, apiPath: string, status: number, body: string) =>
    Object.assign(new Error(`GitHub ${method} ${apiPath} failed with ${status}: ${body}`), { status });

const sleep = async (ms: number) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

export class GitHubRepo {
    constructor(
        private readonly token: string,
        readonly fullName: string,
    ) {}

    private request = async <T>(method: string, apiPath: string, body?: unknown): Promise<T> => {
        // A suite polls for half an hour; one flaky gateway response shouldn't fail it.
        for (let attempt = 1; ; attempt++) {
            const retry = attempt < MAX_ATTEMPTS;
            let response: Response;
            try {
                response = await fetch(`https://api.github.com/repos/${this.fullName}${apiPath}`, {
                    method,
                    headers: {
                        Accept: 'application/vnd.github+json',
                        Authorization: `Bearer ${this.token}`,
                        'X-GitHub-Api-Version': '2022-11-28',
                        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    // Artifact downloads redirect to blob storage, which must not receive the token.
                    redirect: 'manual',
                });
            } catch (error) {
                if (!retry) throw error;
                await sleep(attempt * 5_000);
                continue;
            }

            if (response.status >= 500 && retry) {
                await sleep(attempt * 5_000);
                continue;
            }
            if (response.status >= 300 && response.status < 400) {
                return response.headers.get('location') as T;
            }
            if (!response.ok) {
                throw apiError(method, apiPath, response.status, await response.text());
            }
            return (response.status === 204 ? undefined : await response.json()) as T;
        }
    };

    createPull = async ({ head, base, title, body }: { head: string; base: string; title: string; body: string }) =>
        this.request<{ number: number; html_url: string }>('POST', '/pulls', { head, base, title, body });

    /** Squash-merges, like consumer repos do, and returns the resulting commit on the base branch. */
    squashMerge = async (pullNumber: number, commitTitle: string): Promise<string> => {
        // Right after a push GitHub may still be computing mergeability, and answers 405 until it has.
        for (let attempt = 1; ; attempt++) {
            try {
                const { sha } = await this.request<{ sha: string }>('PUT', `/pulls/${pullNumber}/merge`, {
                    merge_method: 'squash',
                    commit_title: commitTitle,
                    commit_message: '',
                });
                return sha;
            } catch (error) {
                if ((error as { status?: number }).status !== 405 || attempt >= MAX_ATTEMPTS) throw error;
                await sleep(attempt * 10_000);
            }
        }
    };

    closePull = async (pullNumber: number) => this.request('PATCH', `/pulls/${pullNumber}`, { state: 'closed' });

    listOpenPulls = async () =>
        this.request<{ number: number; head: { ref: string } }[]>('GET', '/pulls?state=open&per_page=100');

    listBranches = async (prefix: string): Promise<string[]> => {
        const refs = await this.request<{ ref: string }[]>('GET', `/git/matching-refs/heads/${prefix}`);
        return refs.map(({ ref }) => ref.replace(/^refs\/heads\//, ''));
    };

    deleteBranch = async (branch: string) => this.request('DELETE', `/git/refs/heads/${branch}`);

    dispatchWorkflow = async (workflowFile: string, ref: string, inputs: Record<string, string>) =>
        this.request('POST', `/actions/workflows/${workflowFile}/dispatches`, { ref, inputs });

    /** Runs of the whole repo, or of one workflow when `workflowFile` is given. */
    listRuns = async (query: Record<string, string>, workflowFile?: string): Promise<WorkflowRun[]> => {
        const params = new URLSearchParams({ per_page: '100', ...query });
        const scope = workflowFile ? `/actions/workflows/${workflowFile}` : '/actions';
        const { workflow_runs: runs } = await this.request<{ workflow_runs: WorkflowRun[] }>(
            'GET',
            `${scope}/runs?${params}`,
        );
        return runs;
    };

    cancelRun = async (runId: number) => this.request('POST', `/actions/runs/${runId}/cancel`);

    listJobs = async (runId: number): Promise<Job[]> => {
        const { jobs } = await this.request<{ jobs: Job[] }>('GET', `/actions/runs/${runId}/jobs?per_page=100`);
        return jobs;
    };

    /**
     * Waits for the run of `workflowFile` on `headSha` to appear and complete. Filtering by commit is
     * exact: every step of a scenario pushes a new commit, so there is one run per workflow and sha.
     */
    waitForRun = async ({ workflowFile, event, headSha }: { workflowFile: string; event: string; headSha: string }) => {
        const started = Date.now();
        let run: WorkflowRun | undefined;
        let lastStatus = '';
        for (;;) {
            [run] = await this.listRuns({ event, head_sha: headSha }, workflowFile);

            if (run?.status === 'completed') return run;

            const elapsed = Date.now() - started;
            if (!run && elapsed > RUN_APPEAR_TIMEOUT_MS) {
                throw new Error(
                    `No ${event} run of ${workflowFile} appeared for ${headSha} within ${RUN_APPEAR_TIMEOUT_MS / 60_000} minutes. ` +
                        `Check that the fixture's workflow triggers match the branch and that Actions are enabled in ${this.fullName}.`,
                );
            }
            if (elapsed > RUN_FINISH_TIMEOUT_MS) {
                throw new Error(
                    `${run?.html_url ?? workflowFile} did not finish within ${RUN_FINISH_TIMEOUT_MS / 60_000} minutes.`,
                );
            }

            const status = run ? `${run.status} ${run.html_url}` : 'waiting for the run to appear';
            if (status !== lastStatus) {
                console.error(`    ${workflowFile}: ${status}`);
                lastStatus = status;
            }
            await sleep(POLL_INTERVAL_MS);
        }
    };

    /** Reads one file out of a run's artifact. */
    readArtifactFile = async (runId: number, artifactName: string, fileName: string): Promise<string> => {
        const { artifacts } = await this.request<{ artifacts: { id: number; name: string }[] }>(
            'GET',
            `/actions/runs/${runId}/artifacts?name=${encodeURIComponent(artifactName)}`,
        );
        const artifact = artifacts.find(({ name }) => name === artifactName);
        if (!artifact) throw new Error(`Run ${runId} has no artifact named "${artifactName}".`);

        const downloadUrl = await this.request<string>('GET', `/actions/artifacts/${artifact.id}/zip`);
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error(`Downloading artifact "${artifactName}" failed with ${response.status}.`);

        const entry = new AdmZip(Buffer.from(await response.arrayBuffer())).getEntry(fileName);
        if (!entry) throw new Error(`Artifact "${artifactName}" has no file "${fileName}".`);
        return entry.getData().toString('utf8');
    };
}
