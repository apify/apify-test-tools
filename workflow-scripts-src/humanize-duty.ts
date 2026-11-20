// Records which developer rewrites a new issue in plain language, where the `humanize_duty` input says:
// `label` labels the issue `needs-humanize:<login>`.
//
// The developers are the individual users on the `*` rule of the repo's CODEOWNERS, in the order
// they are listed. Each new issue goes to the developer after the one most recently labeled
// `needs-humanize:<login>`. Labels stay on the issues; the rotation reads them back, so removing one
// makes that developer's turn come round again early.
// With no such issue yet, or when that developer is no longer listed, the rotation starts at a
// developer derived from the repo name, so different repos usually start with different people.
//
// Run from actions/github-script, which passes its `github`, `context` and `core`.

import { createHash } from 'node:crypto';

export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

const LABEL_PREFIX = 'needs-humanize';
const LABEL_COLOR = 'fbca04';

const sameIgnoringCase = (first: string, second: string) => first.toLowerCase() === second.toLowerCase();

export function parseCatchAllOwners(codeowners: string): string[] {
    let owners: string[] = [];
    for (const line of codeowners.split(/\r?\n/)) {
        const [pattern, ...entries] = line.replace(/#.*/, '').trim().split(/\s+/);
        // GitHub applies the last matching rule, so a later `*` line replaces an earlier one.
        if (pattern === '*') owners = entries.filter((entry) => /^@[a-z\d-]+$/i.test(entry));
    }
    return owners
        .map((entry) => entry.slice(1))
        .filter((login, index, logins) => logins.findIndex((other) => sameIgnoringCase(other, login)) === index);
}

export function startOwnerIndex(repoName: string, ownerCount: number): number {
    return createHash('sha256').update(repoName.toLowerCase()).digest().readUInt32BE(0) % ownerCount;
}

export function pickNextOwner(owners: string[], lastLogin: string | undefined, repoName: string): string {
    const lastIndex = lastLogin === undefined ? -1 : owners.findIndex((owner) => sameIgnoringCase(owner, lastLogin));
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
type IssueEvent = { event: string; created_at: string; label?: { name: string } };

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
            listEvents(
                params: RepoParams & { issue_number: number; per_page: number },
            ): Promise<{ data: IssueEvent[] }>;
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

const isAlreadyExists = (error: unknown) => {
    if (!hasStatus(error, 422)) return false;
    const errors = (error as { response?: { data?: { errors?: { code?: string }[] } } }).response?.data?.errors;
    return errors?.some((detail) => detail.code === 'already_exists') ?? false;
};

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

async function findLabeledAt(github: GitHubClient, repo: RepoParams, issue: Issue, labelName: string) {
    const { data: events } = await github.rest.issues.listEvents({
        ...repo,
        issue_number: issue.number,
        per_page: 100,
    });
    const labeledAt = events
        .filter((event) => event.event === 'labeled' && sameIgnoringCase(event.label?.name ?? '', labelName))
        .map((event) => event.created_at)
        .sort();
    return labeledAt.pop() ?? issue.created_at;
}

async function findLastLabeledLogin(github: GitHubClient, repo: RepoParams, prefixLabels: Label[]) {
    let latest: { login: string; labeledAt: string } | undefined;
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
        if (!issue || !login) continue;
        const labeledAt = await findLabeledAt(github, repo, issue, label.name);
        if (!latest || labeledAt > latest.labeledAt) latest = { login, labeledAt };
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

    const label = prefixLabels.find((candidate) => sameIgnoringCase(loginFromLabel(candidate.name) ?? '', login));
    const labelName = label?.name ?? `${LABEL_PREFIX}:${login}`;
    if (!label) {
        try {
            await github.rest.issues.createLabel({
                ...repo,
                name: labelName,
                color: LABEL_COLOR,
                description: `${login} reviews this issue`,
            });
        } catch (error) {
            if (!isAlreadyExists(error)) throw error;
        }
    }

    await github.rest.issues.addLabels({ ...repo, issue_number: issueNumber, labels: [labelName] });
    core.info(
        `Labeled issue #${issueNumber} ${labelName}. Owners on the \`*\` rule of ${codeowners.path}: ` +
            `${owners.join(', ')}. Previous: ${lastLogin ?? 'none'}.`,
    );
}

export async function assignHumanizeDuty({ duty, ...params }: DutyParams & { duty: string }) {
    if (duty !== 'label') throw new Error(`Unsupported humanize_duty '${duty}'. The supported value is 'label'.`);
    await assignHumanizeLabel(params);
}
