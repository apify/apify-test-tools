// Records which developer rewrites a new issue in plain language, where the `humanize_duty` input says:
// `label` labels the issue `needs-humanize:<login>`.
//
// The developers are the individual users on the `*` rule of the repo's CODEOWNERS, in the order
// they are listed. Each new issue goes to the developer after the one on the most recently created
// issue that carries a `needs-humanize:` label, so the rotation never depends on labels being removed.
// With no such issue yet, or when that developer is no longer listed, the rotation starts at a
// developer derived from the repo name, so different repos usually start with different people.
//
// Run from actions/github-script, which passes its `github`, `context` and `core`.

import { createHash } from 'node:crypto';

export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

const LABEL_PREFIX = 'needs-humanize';
const LABEL_COLOR = 'fbca04';

const sameLogin = (first: string, second: string) => first.toLowerCase() === second.toLowerCase();

export function parseCatchAllOwners(codeowners: string): string[] {
    let owners: string[] = [];
    for (const line of codeowners.split(/\r?\n/)) {
        const [pattern, ...entries] = line.replace(/#.*/, '').trim().split(/\s+/);
        // GitHub applies the last matching rule, so a later `*` line replaces an earlier one.
        if (pattern === '*') owners = entries.filter((entry) => /^@[a-z\d-]+$/i.test(entry));
    }
    return owners
        .map((entry) => entry.slice(1))
        .filter((login, index, logins) => logins.findIndex((other) => sameLogin(other, login)) === index);
}

export function startOwnerIndex(repoName: string, ownerCount: number): number {
    return createHash('sha256').update(repoName.toLowerCase()).digest().readUInt32BE(0) % ownerCount;
}

export function pickNextOwner(owners: string[], lastLogin: string | undefined, repoName: string): string {
    const lastIndex = lastLogin === undefined ? -1 : owners.findIndex((owner) => sameLogin(owner, lastLogin));
    const index = lastIndex === -1 ? startOwnerIndex(repoName, owners.length) : (lastIndex + 1) % owners.length;
    return owners[index];
}

export function loginFromLabel(labelName: string): string | undefined {
    const labelPrefix = `${LABEL_PREFIX}:`;
    if (!labelName.toLowerCase().startsWith(labelPrefix.toLowerCase())) return undefined;
    return labelName.slice(labelPrefix.length) || undefined;
}

type RepoParams = { owner: string; repo: string };
type Label = { name: string };
type Issue = { number: number; created_at: string; labels: (string | { name?: string })[] };

export interface GitHubClient {
    rest: {
        repos: {
            getContent(params: RepoParams & { path: string }): Promise<{ data: unknown }>;
        };
        issues: {
            get(params: RepoParams & { issue_number: number }): Promise<{ data: Issue }>;
            listLabelsForRepo(params: RepoParams & { per_page: number }): Promise<{ data: Label[] }>;
            listForRepo(
                params: RepoParams & {
                    labels: string;
                    state: 'all';
                    sort: 'created';
                    direction: 'desc';
                    per_page: number;
                },
            ): Promise<{ data: Issue[] }>;
            createLabel(params: RepoParams & { name: string; color: string; description: string }): Promise<unknown>;
            addLabels(params: RepoParams & { issue_number: number; labels: string[] }): Promise<unknown>;
        };
    };
    paginate<Item>(
        method: (params: RepoParams & { per_page: number }) => Promise<{ data: Item[] }>,
        params: RepoParams & { per_page: number },
    ): Promise<Item[]>;
}

interface Core {
    info(message: string): void;
    warning(message: string): void;
}

const hasStatus = (error: unknown, status: number) =>
    typeof error === 'object' && error !== null && 'status' in error && error.status === status;

const labelNames = (issue: Issue) =>
    issue.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? '')));

async function readCodeowners(github: GitHubClient, repo: RepoParams) {
    for (const path of CODEOWNERS_PATHS) {
        try {
            const { data } = await github.rest.repos.getContent({ ...repo, path });
            if (typeof data === 'object' && data !== null && 'content' in data && typeof data.content === 'string') {
                return { path, content: Buffer.from(data.content, 'base64').toString('utf8') };
            }
        } catch (error) {
            if (!hasStatus(error, 404)) throw error;
        }
    }
    return undefined;
}

async function findLastLabeledLogin(github: GitHubClient, repo: RepoParams, prefixLabels: Label[]) {
    let latest: { login: string; createdAt: string } | undefined;
    for (const label of prefixLabels) {
        const { data } = await github.rest.issues.listForRepo({
            ...repo,
            labels: label.name,
            state: 'all',
            sort: 'created',
            direction: 'desc',
            per_page: 1,
        });
        const [issue] = data;
        const login = loginFromLabel(label.name);
        if (issue && login && (!latest || issue.created_at > latest.createdAt)) {
            latest = { login, createdAt: issue.created_at };
        }
    }
    return latest?.login;
}

type DutyParams = { github: GitHubClient; context: { repo: RepoParams }; core: Core; issueNumber: number };

async function assignHumanizeLabel({ github, context, core, issueNumber }: DutyParams) {
    const { repo } = context;

    const codeowners = await readCodeowners(github, repo);
    if (!codeowners) {
        core.warning(`No CODEOWNERS file at ${CODEOWNERS_PATHS.join(', ')}, so no ${LABEL_PREFIX} label is added.`);
        return;
    }
    const owners = parseCatchAllOwners(codeowners.content);
    if (owners.length === 0) {
        core.warning(
            `${codeowners.path} lists no individual users on its \`*\` rule, so no ${LABEL_PREFIX} label is added.`,
        );
        return;
    }

    const { data: issue } = await github.rest.issues.get({ ...repo, issue_number: issueNumber });
    const existing = labelNames(issue).find((name) => loginFromLabel(name));
    if (existing) {
        core.info(`Issue #${issueNumber} already has ${existing}.`);
        return;
    }

    const labels = await github.paginate(github.rest.issues.listLabelsForRepo, { ...repo, per_page: 100 });
    const prefixLabels = labels.filter((label) => loginFromLabel(label.name));
    const lastLogin = await findLastLabeledLogin(github, repo, prefixLabels);
    const login = pickNextOwner(owners, lastLogin, repo.repo);

    const label = prefixLabels.find((candidate) => sameLogin(loginFromLabel(candidate.name) ?? '', login));
    const labelName = label?.name ?? `${LABEL_PREFIX}:${login}`;
    if (!label) {
        try {
            await github.rest.issues.createLabel({
                ...repo,
                name: labelName,
                color: LABEL_COLOR,
                description: `${login} rewrites this issue in plain language`,
            });
        } catch (error) {
            if (!hasStatus(error, 422)) throw error;
        }
    }

    await github.rest.issues.addLabels({ ...repo, issue_number: issueNumber, labels: [labelName] });
    core.info(
        `Labeled issue #${issueNumber} ${labelName}. Owners on the \`*\` rule of ${codeowners.path}: ` +
            `${owners.join(', ')}. Previous: ${lastLogin ?? 'none'}.`,
    );
}

const DUTIES = new Map<string, (params: DutyParams) => Promise<void>>([['label', assignHumanizeLabel]]);

export async function assignHumanizeDuty({ duty, ...params }: DutyParams & { duty: string }) {
    const assign = DUTIES.get(duty);
    if (!assign) {
        const supported = [...DUTIES.keys()].map((name) => `'${name}'`).join(', ');
        throw new Error(`Unsupported humanize_duty '${duty}'. Supported values: ${supported}.`);
    }
    await assign(params);
}
