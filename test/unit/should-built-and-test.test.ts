import type { MockInstance } from 'vitest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { getChangedActors } from '../../bin/diff-changes.js';
import * as DiffJsonSchema from '../../bin/diff-json-schema.js';
import type { ActorConfig, Commit } from '../../bin/types.js';

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

    const commits: Commit[] = [
        { sha: 'Commit1', author: '', date: '', message: '' },
        { sha: 'Commit3', author: '', date: '', message: '' },
    ];

    let isCosmeticOnlyJsonSchemaSpy: MockInstance;

    beforeEach(() => {
        // Default: JSON changes are functional (triggers build/test)
        isCosmeticOnlyJsonSchemaSpy = vi.spyOn(DiffJsonSchema, 'isCosmeticOnlyJsonSchemaChange').mockReturnValue(false);
    });

    test('Ignores dev-only readme', () => {
        const FILES = ['README.md', 'code/README.md', 'shared/README.md'];

        const actorsChanged = getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: false, filepathsChanged: FILES, commits });

        expect(actorsChanged).toEqual([]);
    });

    test('Ignores other ignored files and folders', () => {
        const FILES = ['.vscode/', '.gitignore', '.husky/', '.eslintrc', '.editorconfig', '.actor/'];

        const actorsChanged = getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: false, filepathsChanged: FILES, commits });

        expect(actorsChanged).toEqual([]);
    });

    test('Only builds latest for all Actors', () => {
        const FILES = ['shared/CHANGELOG.md', 'CHANGELOG.md'];

        const actorsChanged = getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: true, filepathsChanged: FILES, commits });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS.filter(({ isStandalone }) => !isStandalone));
    });

    test('Code updated, tests miniactors', () => {
        const FILES = ['code/src/main.ts', 'package.json'];

        const actorsChanged = getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: false, filepathsChanged: FILES, commits });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS.filter(({ isStandalone }) => !isStandalone));
    });

    test('Specific Actor functionality configs updated', () => {
        const FILES = ['actors/lukaskrivka_testing-github-integration-1/.actor/actor.json', 'standalone-actors/lukaskrivka_test-standalone/Dockerfile'];
        // Default mock returns false = functional change

        const actorsChanged = getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: false, filepathsChanged: FILES, commits });

        expect(actorsChanged).toEqual([ACTOR_CONFIGS[0], ACTOR_CONFIGS[2]]);
    });

    test('src/main.ts updated', () => {
        const FILES = [
            'src/main.ts',
        ];

        const actorsChanged = getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: true, filepathsChanged: FILES, commits });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS.slice(0, 2));
    });

    test('Miniactor, Code and standalone actor updated,', () => {
        const FILES = [
            'actors/lukaskrivka_testing-github-integration-1/.actor/actor.json',
            'code/src/main.ts',
            'standalone-actors/lukaskrivka_test-standalone/Dockerfile',
        ];
        // Default mock returns false = functional change for the JSON file

        const actorsChanged = getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: false, filepathsChanged: FILES, commits });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS);
    });

    test('Specific Actor non-functional configs updated', () => {
        const FILES = ['actors/lukaskrivka_testing-github-integration-2/.actor/README.md', 'standalone-actors/lukaskrivka_test-standalone/CHANGELOG.md'];

        const actorsChanged = getChangedActors({ actorConfigs: ACTOR_CONFIGS, isLatest: false, filepathsChanged: FILES, commits });

        expect(actorsChanged).toEqual([]);
    });

    test('JSON file with cosmetic-only changes in PR context (isLatest=false) skips tests', () => {
        const FILES = ['actors/lukaskrivka_testing-github-integration-1/.actor/actor.json'];
        isCosmeticOnlyJsonSchemaSpy.mockReturnValue(true);

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual([]);
    });

    test('JSON file with cosmetic-only changes in latest context still triggers build', () => {
        const FILES = ['actors/lukaskrivka_testing-github-integration-1/.actor/actor.json'];
        isCosmeticOnlyJsonSchemaSpy.mockReturnValue(true);

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: true,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual([ACTOR_CONFIGS[0]]);
    });

    test('JSON file with functional changes triggers tests', () => {
        const FILES = ['actors/lukaskrivka_testing-github-integration-1/.actor/actor.json'];
        // Default mock returns false = functional change

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual([ACTOR_CONFIGS[0]]);
    });

    test('Mix: one actor has cosmetic-only JSON change, another has functional JSON change', () => {
        const FILES = [
            'actors/lukaskrivka_testing-github-integration-1/.actor/actor.json',
            'actors/lukaskrivka_testing-github-integration-2/.actor/input_schema.json',
        ];
        // Actor 1 JSON is cosmetic-only, actor 2 JSON is functional
        isCosmeticOnlyJsonSchemaSpy.mockImplementation((_commits, filepath: string) =>
            !filepath.includes('input_schema.json'),
        );

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        // Only the second actor (functional change) should be built and tested
        expect(actorsChanged).toEqual([ACTOR_CONFIGS[1]]);
    });

    test('Standalone actor with cosmetic-only JSON change in PR context skips tests', () => {
        const FILES = ['standalone-actors/lukaskrivka_test-standalone/.actor/actor.json'];
        isCosmeticOnlyJsonSchemaSpy.mockReturnValue(true);

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual([]);
    });

    test('Google Maps real user-case that had undefined', () => {
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

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS_GOOGLE_MAPS, isLatest: false, filepathsChanged: FILES, commits,
        });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS_GOOGLE_MAPS.filter(({ isStandalone }) => !isStandalone));
    });
});
