// Shared by lukaskrivka/testing-github-integration and lukaskrivka/testing-github-integration-2.
// Plain JavaScript on purpose: the image installs production dependencies only (see Dockerfile).
import { CheerioCrawler } from '@crawlee/cheerio';
import { Actor } from 'apify';

await Actor.init();

const { startUrls = ['https://crawlee.dev'], maxRequestsPerCrawl = 5 } = (await Actor.getInput()) ?? {};

const crawler = new CheerioCrawler({
    maxRequestsPerCrawl,
    requestHandler: async ({ enqueueLinks, request, $, log }) => {
        const title = $('title').text();
        log.info(title, { url: request.loadedUrl });
        await Actor.pushData({ url: request.loadedUrl, title });
        await enqueueLinks();
    },
});

await crawler.run(startUrls);

await Actor.exit();
