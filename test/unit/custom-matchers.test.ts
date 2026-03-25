import process from 'node:process';

import { ApifyClient } from 'apify-client';
import { describe } from 'vitest';

import { testStandbyActor, testTestActor } from '../../lib/lib.js';
import { RunTestResult } from '../../lib/run-test-result.js';

type PpeEventType = 'actor-start' | 'search-page-scraped' | 'ads-scraped';
enum PpeEventEnum {
    ACTOR_START = 'actor-start',
    SEARCH_PAGE_SCRAPED = 'search-page-scraped',
    ADS_SCRAPED = 'ads-scraped',
}
type PPE_EVENT_CONST = {
    ACTOR_START: 'actor-start';
    ITEM_PUSHED: 'search-page-scraped';
    ADS_SCRAPED: 'ads-scraped';
};

// TODO: Remake these tests. k5MNKmaDGHlABDn2I run doesn't exist and we probably don't want to depend on fixed run
describe.skip('custom-matchers', { timeout: 100_000 }, () => {
    testTestActor('basic', async ({ expect }) => {
        const apifyClient = new ApifyClient({ token: process.env.TESTER_APIFY_TOKEN });
        const run = await apifyClient.run('k5MNKmaDGHlABDn2I').get();
        const runResult = new RunTestResult(apifyClient, run!);
        await expect(runResult).toFinishWith<PpeEventType>({
            datasetItemCount: { min: 10, max: 20 },
            duration: 10,
            status: 'TIMING-OUT',
            chargedEventCounts: {
                'actor-start': 1,
                'search-page-scraped': { min: 1 },
                'ads-scraped': 3,
            },
        });

        await expect(runResult).toFinishWith<PpeEventEnum>({
            datasetItemCount: { min: 10, max: 20 },
            chargedEventCounts: {
                'actor-start': 1,
                'search-page-scraped': { min: 1 },
                'ads-scraped': 0,
            },
        });

        await expect(runResult).toFinishWith<PPE_EVENT_CONST[keyof PPE_EVENT_CONST]>({
            datasetItemCount: { min: 1, max: 20 },
            chargedEventCounts: {
                'actor-start': 1,
                'search-page-scraped': { min: 1 },
                'ads-scraped': 0,
            },
        });

        expect(3).toEqual(3);
        expect.hard(5).toEqual(5);
        expect(10).toEqual(10);
    });

    testStandbyActor('ondrejklinovsky/contact-info', 'CDS standby', async ({ expect, callStandby }) => {
        {
            const { data, status } = await callStandby({
                input: {
                    startUrls: [{ url: 'https://apify.com' }],
                    maxRequests: 3,
                    aggregateContacts: true,
                },
            });
            expect(status).toBe(200);
            expect(data[0].domain).toEqual('apify.com');
        }

        const { data, status } = await callStandby({
            input: {
                startUrls: [{ url: 'https://apify.com' }],
                maxRequests: 3,
                aggregateContacts: true,
            },
        });
        expect(status).toBe(200);
        expect(data[0].domain).toEqual('apify.com');
    });
});
