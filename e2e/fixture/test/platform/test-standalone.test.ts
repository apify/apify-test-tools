import { describe, testActor } from 'apify-test-tools';

describe('test-standalone', () => {
    testActor('lukaskrivka/test-standalone', 'extracts headings', async ({ expect, run }) => {
        const runResult = await run({ input: { url: 'https://crawlee.dev' } });
        await expect.hard(runResult).toFinishWith({
            datasetItemCount: { min: 1 },
        });
    });
});
