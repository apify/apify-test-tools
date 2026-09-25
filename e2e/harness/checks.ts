import fs from 'node:fs';

/**
 * Collects pass/fail lines for a step, prints them, and adds them to the job summary.
 */
export class Checks {
    private readonly lines: { ok: boolean; message: string }[] = [];

    constructor(private readonly title: string) {}

    check = (ok: boolean, message: string) => {
        this.lines.push({ ok, message });
    };

    /** Expects `actual` to be exactly the set `expected`, order aside. */
    sameSet = (label: string, actual: string[], expected: string[]) => {
        const a = [...new Set(actual)].sort();
        const e = [...new Set(expected)].sort();
        this.check(a.join(',') === e.join(','), `${label}: expected [${e.join(', ')}], got [${a.join(', ')}]`);
    };

    get failed() {
        return this.lines.some(({ ok }) => !ok);
    }

    /** Prints the results and throws if any check failed. */
    finish = (links: string[] = []) => {
        const report = [
            `### ${this.failed ? '❌' : '✅'} ${this.title}`,
            '',
            ...this.lines.map(({ ok, message }) => `- ${ok ? '✅' : '❌'} ${message}`),
            ...links.map((link) => `- ${link}`),
            '',
        ].join('\n');
        console.error(report);
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
        if (this.failed) throw new Error(`E2E step failed: ${this.title}`);
    };
}
