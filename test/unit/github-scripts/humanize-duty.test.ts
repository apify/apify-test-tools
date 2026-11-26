import { describe, expect, it } from 'vitest';

import type * as HumanizeDuty from '../../../workflow-scripts-src/humanize-duty.js';

const BUNDLE = new URL('../../../.github/scripts/humanize-duty.mjs', import.meta.url).href;

const { assignHumanizeDuty, loginFromLabel, parseCatchAllOwners, pickNextOwner, startOwnerIndex }: typeof HumanizeDuty =
    await import(BUNDLE);

describe('parseCatchAllOwners', () => {
    it('keeps the individual users on the `*` rule, in order', () => {
        const codeowners = ['# Owners', '*   @alice @my-org/team bob@example.com @Bob-2  # leads', ''].join('\n');
        expect(parseCatchAllOwners(codeowners)).toStrictEqual(['alice', 'Bob-2']);
    });

    it('ignores rules for other patterns', () => {
        expect(parseCatchAllOwners('/docs/ @writer\n* @alice\n*.ts @reviewer')).toStrictEqual(['alice']);
    });

    it('uses the last `*` rule, like GitHub does', () => {
        expect(parseCatchAllOwners('* @alice @bob\n* @carol')).toStrictEqual(['carol']);
    });

    it('drops repeated users, ignoring case', () => {
        expect(parseCatchAllOwners('* @alice @bob @Alice')).toStrictEqual(['alice', 'bob']);
    });

    it.each([
        ['has no `*` rule', '/src/ @alice'],
        ['has only teams and emails on its `*` rule', '* @my-org/team alice@example.com'],
        ['has a commented-out `*` rule', '# * @alice'],
        ['is empty', ''],
    ])('returns nothing when CODEOWNERS %s', (_, codeowners) => {
        expect(parseCatchAllOwners(codeowners)).toStrictEqual([]);
    });

    it('reads CRLF line endings', () => {
        expect(parseCatchAllOwners('* @alice\r\n/docs/ @bob\r\n')).toStrictEqual(['alice']);
    });
});

describe('startOwnerIndex', () => {
    it('is stable for a repo and within range', () => {
        const index = startOwnerIndex('my-repo', 5);
        expect(index).toBe(startOwnerIndex('my-repo', 5));
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(5);
    });

    it('ignores the case of the repo name', () => {
        expect(startOwnerIndex('My-Repo', 7)).toBe(startOwnerIndex('my-repo', 7));
    });

    it('spreads different repos over different owners', () => {
        const starts = new Set(
            ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((repo) => startOwnerIndex(repo, 4)),
        );
        expect(starts.size).toBeGreaterThan(1);
    });
});

describe('pickNextOwner', () => {
    const owners = ['alice', 'bob', 'carol'];

    it('picks the owner after the last one', () => {
        expect(pickNextOwner(owners, 'alice', 'repo')).toBe('bob');
        expect(pickNextOwner(owners, 'bob', 'repo')).toBe('carol');
    });

    it('wraps around after the last owner', () => {
        expect(pickNextOwner(owners, 'carol', 'repo')).toBe('alice');
    });

    it('matches the last owner ignoring case', () => {
        expect(pickNextOwner(owners, 'ALICE', 'repo')).toBe('bob');
    });

    it.each([
        ['nobody was labeled yet', undefined],
        ['the last owner left CODEOWNERS', 'dave'],
    ])('starts at the owner derived from the repo name when %s', (_, lastLogin) => {
        expect(pickNextOwner(owners, lastLogin, 'repo')).toBe(owners[startOwnerIndex('repo', owners.length)]);
    });

    it('keeps picking the only owner', () => {
        expect(pickNextOwner(['alice'], 'alice', 'repo')).toBe('alice');
    });
});

describe('loginFromLabel', () => {
    it('reads the login after the prefix, ignoring the prefix case', () => {
        expect(loginFromLabel('needs-humanize:alice')).toBe('alice');
        expect(loginFromLabel('Needs-Humanize:alice')).toBe('alice');
    });

    it.each([['needs-humanize'], ['needs-humanize:'], ['needs-humanize-later:alice'], ['claude']])(
        'returns nothing for %s',
        (labelName) => {
            expect(loginFromLabel(labelName)).toBeUndefined();
        },
    );
});

type FakeIssue = { number: number; created_at: string; labels: string[] };
type FakeEvent = { issueNumber: number; event: string; created_at: string; label: { name: string } };

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

const LABEL_ERROR_ALREADY_EXISTS = Object.assign(new Error('Validation Failed'), {
    status: 422,
    response: { data: { errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] } },
});

// Labels added through the fake land on the issue with a `labeled` event, timed after every issue was created.
function fakeGitHub({
    files,
    issues,
    labels,
    createLabelError,
}: {
    files: Record<string, string>;
    issues: FakeIssue[];
    labels: string[];
    createLabelError?: Error;
}) {
    const repoIssues = structuredClone(issues);
    const repoLabels = [...labels];
    const created: string[] = [];
    const added: string[] = [];
    const events: FakeEvent[] = [];
    const labeledAt = () => new Date(Date.UTC(2026, 11, 1) + events.length * 1000).toISOString();
    const client: HumanizeDuty.GitHubClient = {
        rest: {
            repos: {
                getContent: async ({ path }) => {
                    if (!(path in files)) throw notFound();
                    return { data: { type: 'file', content: Buffer.from(files[path]).toString('base64') } };
                },
            },
            issues: {
                get: async ({ issue_number: issueNumber }) => {
                    const issue = repoIssues.find((candidate) => candidate.number === issueNumber);
                    if (!issue) throw notFound();
                    return { data: issue };
                },
                listLabelsForRepo: async () => ({ data: repoLabels.map((name) => ({ name })) }),
                listForRepo: async ({ labels: labelName }) => ({
                    data: repoIssues
                        .filter((issue) => issue.labels.includes(labelName))
                        .sort((first, second) => second.created_at.localeCompare(first.created_at))
                        .slice(0, 1),
                }),
                listEvents: async ({ issue_number: issueNumber }) => ({
                    data: events.filter((event) => event.issueNumber === issueNumber),
                }),
                createLabel: async ({ name }) => {
                    if (createLabelError) throw createLabelError;
                    created.push(name);
                    repoLabels.push(name);
                },
                addLabels: async ({ issue_number: issueNumber, labels: names }) => {
                    const issue = repoIssues.find((candidate) => candidate.number === issueNumber);
                    if (!issue) throw notFound();
                    for (const name of names) {
                        events.push({ issueNumber, event: 'labeled', created_at: labeledAt(), label: { name } });
                        issue.labels.push(name);
                    }
                    added.push(...names);
                },
            },
        },
        paginate: async (method, params) => (await method(params)).data,
    };
    return { client, created, added };
}

const run = async (github: HumanizeDuty.GitHubClient, duty = 'label', issueNumber = 10) => {
    const warnings: string[] = [];
    await assignHumanizeDuty({
        github,
        context: { repo: { owner: 'my-org', repo: 'my-repo' } },
        core: { info: () => undefined, warning: (message) => warnings.push(message) },
        duty,
        issueNumber,
    });
    return warnings;
};

describe('assignHumanizeDuty', () => {
    const newIssue = { number: 10, created_at: '2026-11-03T00:00:00Z', labels: ['claude'] };

    it('falls back to when an issue was created for labels without a labeled event', async () => {
        const fake = fakeGitHub({
            files: { '.github/CODEOWNERS': '* @alice @bob @carol' },
            labels: ['needs-humanize:alice', 'needs-humanize:bob'],
            issues: [
                { number: 1, created_at: '2026-11-01T00:00:00Z', labels: ['needs-humanize:bob'] },
                { number: 2, created_at: '2026-11-02T00:00:00Z', labels: ['needs-humanize:alice'] },
                newIssue,
            ],
        });
        expect(await run(fake.client)).toStrictEqual([]);
        expect(fake.added).toStrictEqual(['needs-humanize:bob']);
        expect(fake.created).toStrictEqual([]);
    });

    it('creates the label when the owner has none yet', async () => {
        const fake = fakeGitHub({
            files: { CODEOWNERS: '* @alice @bob' },
            labels: ['needs-humanize:alice'],
            issues: [{ number: 1, created_at: '2026-11-01T00:00:00Z', labels: ['needs-humanize:alice'] }, newIssue],
        });
        await run(fake.client);
        expect(fake.created).toStrictEqual(['needs-humanize:bob']);
        expect(fake.added).toStrictEqual(['needs-humanize:bob']);
    });

    it('reuses an existing label whose login differs in case', async () => {
        const fake = fakeGitHub({
            files: { 'docs/CODEOWNERS': '* @alice @bob' },
            labels: ['needs-humanize:alice', 'needs-humanize:Bob'],
            issues: [{ number: 1, created_at: '2026-11-01T00:00:00Z', labels: ['needs-humanize:alice'] }, newIssue],
        });
        await run(fake.client);
        expect(fake.created).toStrictEqual([]);
        expect(fake.added).toStrictEqual(['needs-humanize:Bob']);
    });

    it('starts at the owner derived from the repo name when no issue is labeled yet', async () => {
        const owners = ['alice', 'bob', 'carol'];
        const fake = fakeGitHub({
            files: { '.github/CODEOWNERS': `* ${owners.map((owner) => `@${owner}`).join(' ')}` },
            labels: [],
            issues: [newIssue],
        });
        await run(fake.client);
        expect(fake.added).toStrictEqual([`needs-humanize:${owners[startOwnerIndex('my-repo', owners.length)]}`]);
    });

    it('leaves an issue that already has a label alone', async () => {
        const fake = fakeGitHub({
            files: { '.github/CODEOWNERS': '* @alice @bob' },
            labels: ['needs-humanize:alice'],
            issues: [{ ...newIssue, labels: ['claude', 'needs-humanize:alice'] }],
        });
        await run(fake.client);
        expect(fake.added).toStrictEqual([]);
    });

    it('warns and skips without CODEOWNERS', async () => {
        const fake = fakeGitHub({ files: {}, labels: [], issues: [newIssue] });
        expect(await run(fake.client)).toStrictEqual([
            'No CODEOWNERS file at .github/CODEOWNERS, CODEOWNERS, docs/CODEOWNERS, so no needs-humanize label is added.',
        ]);
        expect(fake.added).toStrictEqual([]);
    });

    it('warns and skips when the `*` rule lists no individual users', async () => {
        const fake = fakeGitHub({ files: { '.github/CODEOWNERS': '* @my-org/team' }, labels: [], issues: [newIssue] });
        expect(await run(fake.client)).toStrictEqual([
            '.github/CODEOWNERS lists no individual users on its `*` rule, so no needs-humanize label is added.',
        ]);
        expect(fake.added).toStrictEqual([]);
    });

    it('takes turns by when each label was added, not when its issue was created', async () => {
        const fake = fakeGitHub({
            files: { '.github/CODEOWNERS': '* @alice @bob @carol' },
            labels: ['needs-humanize:alice'],
            issues: [
                { number: 10, created_at: '2026-11-01T00:00:00Z', labels: ['needs-humanize:alice'] },
                { number: 11, created_at: '2026-11-02T00:00:00Z', labels: ['claude'] },
                { number: 12, created_at: '2026-11-03T00:00:00Z', labels: ['claude'] },
                { number: 13, created_at: '2026-11-04T00:00:00Z', labels: ['claude'] },
            ],
        });
        await run(fake.client, 'label', 12);
        await run(fake.client, 'label', 11);
        await run(fake.client, 'label', 13);
        expect(fake.added).toStrictEqual(['needs-humanize:bob', 'needs-humanize:carol', 'needs-humanize:alice']);
    });

    it('reads .github/CODEOWNERS before the one in the root', async () => {
        const fake = fakeGitHub({
            files: { '.github/CODEOWNERS': '* @alice', CODEOWNERS: '* @bob' },
            labels: [],
            issues: [newIssue],
        });
        await run(fake.client);
        expect(fake.added).toStrictEqual(['needs-humanize:alice']);
    });

    it('adds the label when creating it finds it already exists', async () => {
        const fake = fakeGitHub({
            files: { '.github/CODEOWNERS': '* @alice' },
            labels: [],
            issues: [newIssue],
            createLabelError: LABEL_ERROR_ALREADY_EXISTS,
        });
        await run(fake.client);
        expect(fake.added).toStrictEqual(['needs-humanize:alice']);
    });

    it('fails when creating the label is rejected for another reason', async () => {
        const invalid = Object.assign(new Error('Validation Failed'), {
            status: 422,
            response: { data: { errors: [{ resource: 'Label', code: 'invalid', field: 'name' }] } },
        });
        const fake = fakeGitHub({
            files: { '.github/CODEOWNERS': '* @alice' },
            labels: [],
            issues: [newIssue],
            createLabelError: invalid,
        });
        await expect(run(fake.client)).rejects.toBe(invalid);
        expect(fake.added).toStrictEqual([]);
    });

    it.each([['label:needs-humanize'], ['Label'], ['field'], [' label']])(
        'fails on %s, naming the supported value, without labeling',
        async (duty) => {
            const fake = fakeGitHub({ files: { '.github/CODEOWNERS': '* @alice' }, labels: [], issues: [newIssue] });
            await expect(run(fake.client, duty)).rejects.toThrow(
                `Unsupported humanize_duty '${duty}'. The supported value is 'label'.`,
            );
            expect(fake.created).toStrictEqual([]);
            expect(fake.added).toStrictEqual([]);
        },
    );
});
