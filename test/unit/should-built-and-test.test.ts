import { describe, expect, test } from 'vitest';

import type { ActorConfig } from '../../bin/types.js';
import { getChangedActors } from '../../bin/utils.js';

describe('Should build and test parser', () => {
    // From https://github.com/apify-store/testing-repo-for-github-actions
    const ACTOR_CONFIGS: ActorConfig[] = [
        {
            actorName: 'lukaskrivka/testing-github-integration-1',
            folder: 'actors/lukaskrivka_testing-github-integration-1',
            isStandalone: false,
        },
        {
            actorName: 'lukaskrivka/testing-github-integration-2',
            folder: 'actors/lukaskrivka_testing-github-integration-2',
            isStandalone: false,
        },
        {
            actorName: 'lukaskrivka/test-standalone',
            folder: 'standalone-actors/lukaskrivka_test-standalone',
            isStandalone: true,
        },
    ];

    test('Ignores dev-only readme', async () => {
        const FILES = ['README.md', 'code/README.md', 'shared/README.md'];

        const { actorsChanged, codeChanged } = await getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: false, filepathsChanged: FILES });

        expect(actorsChanged).toEqual([]);
        expect(codeChanged).toBe(false);
    });

    test('Ignores other ignored files and folders', async () => {
        const FILES = ['.vscode/', '.gitignore', '.husky/', '.eslintrc', '.editorconfig', '.actor/'];

        const { actorsChanged, codeChanged } = await getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: false, filepathsChanged: FILES });

        expect(actorsChanged).toEqual([]);
        expect(codeChanged).toBe(false);
    });

    test('Only builds latest for all Actors', async () => {
        const FILES = ['shared/CHANGELOG.md', 'CHANGELOG.md'];

        const { actorsChanged, codeChanged } = await getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: true, filepathsChanged: FILES });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS.filter(({ isStandalone }) => !isStandalone));
        expect(codeChanged).toBe(false);
    });

    test('Code updated, tests miniactors', async () => {
        const FILES = ['code/src/main.ts', 'package.json'];

        const { actorsChanged, codeChanged } = await getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: false, filepathsChanged: FILES });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS.filter(({ isStandalone }) => !isStandalone));
        expect(codeChanged).toBe(true);
    });

    test('Specific Actor functionality configs updated', async () => {
        const FILES = ['actors/lukaskrivka_testing-github-integration-1/.actor/actor.json', 'standalone-actors/lukaskrivka_test-standalone/Dockerfile'];

        const { actorsChanged, codeChanged } = await getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: false, filepathsChanged: FILES });

        expect(actorsChanged).toEqual([ACTOR_CONFIGS[0], ACTOR_CONFIGS[2]]);
        expect(codeChanged).toBe(false);
    });

    test('src/main.ts updated', async () => {
        const FILES = [
            'src/main.ts',
        ];

        const { actorsChanged, codeChanged } = await getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: true, filepathsChanged: FILES });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS.slice(0, 2));
        expect(codeChanged).toBe(false);
    });

    test('Miniactor, Code and standalone actor updated,', async () => {
        const FILES = [
            'actors/lukaskrivka_testing-github-integration-1/.actor/actor.json',
            'code/src/main.ts',
            'standalone-actors/lukaskrivka_test-standalone/Dockerfile',
        ];

        const { actorsChanged, codeChanged } = await getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: false, filepathsChanged: FILES });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS);
        expect(codeChanged).toBe(true);
    });

    test('Specific Actor non-functional configs updated', async () => {
        const FILES = ['actors/lukaskrivka_testing-github-integration-2/.actor/README.md', 'standalone-actors/lukaskrivka_test-standalone/CHANGELOG.md'];

        const { actorsChanged, codeChanged } = await getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: false, filepathsChanged: FILES });

        expect(actorsChanged).toEqual([]);
        expect(codeChanged).toBe(false);
    });

    test('Google Maps real user-case that had undefined', async () => {
        const FILES = ['actors/compass_Google-Maps-Reviews-Scraper/.actor/INPUT_SCHEMA.json', 'actors/compass_crawler-google-places/.actor/INPUT_SCHEMA.json',
            'code/src/consts.ts', 'code/src/crawlers/cheerio/routes.ts', 'code/src/detail_page_handle.ts', 'code/src/enqueue_places.ts',
            'code/src/helper-classes/initialize-all.ts', 'code/src/helper-classes/stats.ts', 'code/src/helper-classes/unmatched-categories.ts',
            'code/src/main.ts', 'code/src/typedefs/general.ts', 'code/src/utils/background-enqueue.ts'];

        const ACTOR_CONFIGS_GOOGLE_MAPS: ActorConfig[] = [
            {
                // Edge case of capitals in actor name :)
                actorName: 'compass/Google-Maps-Reviews-Scraper',
                folder: 'actors/compass_Google-Maps-Reviews-Scraper',
                isStandalone: false,
            },
            {
                actorName: 'compass/crawler-google-places',
                folder: 'actors/compass_crawler-google-places',
                isStandalone: false,
            },
            {
                actorName: 'compass/easy-google-maps',
                folder: 'actors/compass_easy-google-maps',
                isStandalone: false,
            },
            {
                actorName: 'compass/google-maps-extractor',
                folder: 'actors/compass_google-maps-extractor',
                isStandalone: false,
            },
            {
                actorName: 'compass/google-places-api',
                folder: 'actors/compass_google-places-api',
                isStandalone: false,
            },
            {
                actorName: 'lukaskrivka/google-maps-with-contact-details',
                folder: 'actors/lukaskrivka_google-maps-with-contact-details',
                isStandalone: false,
            },
            {
                actorName: 'natasha.lekh/gas-prices-scraper',
                folder: 'actors/natasha.lekh_gas-prices-scraper',
                isStandalone: false,
            },
            {
                actorName: 'natasha.lekh/vegan-places-finder',
                folder: 'actors/natasha.lekh_vegan-places-finder',
                isStandalone: false,
            },
            {
                actorName: 'lukaskrivka/google-maps-scraper-orchestrator',
                folder: 'standalone-actors/lukaskrivka_google-maps-scraper-orchestrator',
                isStandalone: true,
            },
        ];

        const { actorsChanged, codeChanged } = await getChangedActors({
            actorConfigs: ACTOR_CONFIGS_GOOGLE_MAPS, isLatest: false, filepathsChanged: FILES,
        });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS_GOOGLE_MAPS.filter(({ isStandalone }) => !isStandalone));
        expect(codeChanged).toBe(true);
    });
});
