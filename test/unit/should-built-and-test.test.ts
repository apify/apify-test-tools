import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { getChangedActors } from '../../bin/diff-changes.js';
import type { ActorConfig, Commit } from '../../bin/types.js';
import { ExistingDir, ExistingFile, RelativeDir, RelativeFile } from '../../bin/utils/path/repo-relative.js';

const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apify-should-build-'));
process.chdir(fixtureRoot);

afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

const actorConfig = (
    actorFullName: string,
    folder: string,
    tokenEnvVar: string,
    dockerContextDir = '.',
): ActorConfig => {
    const actorJsonPath = path.posix.join(folder, '.actor/actor.json');
    fs.mkdirSync(path.posix.dirname(actorJsonPath), { recursive: true });
    fs.writeFileSync(actorJsonPath, '{}');
    const contextPath = new RelativeDir(dockerContextDir);
    return {
        actorFullName,
        folder: new ExistingDir(folder),
        tokenEnvVar,
        actorJson: {
            file: new ExistingFile(actorJsonPath),
            dockerContextDir: contextPath,
            changelog: new RelativeFile('CHANGELOG.md'),
        },
        dockerContextDir: contextPath,
        contextPaths: [contextPath],
    };
};

describe('Should build and test parser', () => {
    // From https://github.com/apify-store/testing-repo-for-github-actions
    const ACTOR_CONFIGS: ActorConfig[] = [
        actorConfig(
            'lukaskrivka/testing-github-integration-1',
            'actors/lukaskrivka_testing-github-integration-1',
            'APIFY_TOKEN_LUKASKRIVKA',
        ),
        actorConfig(
            'lukaskrivka/testing-github-integration-2',
            'actors/lukaskrivka_testing-github-integration-2',
            'APIFY_TOKEN_LUKASKRIVKA',
        ),
        actorConfig(
            'lukaskrivka/test-standalone',
            'standalone-actors/lukaskrivka_test-standalone',
            'APIFY_TOKEN_LUKASKRIVKA',
            'standalone-actors/lukaskrivka_test-standalone',
        ),
    ];

    const commits: Commit[] = [
        { sha: 'Commit1', author: '', date: '', message: '' },
        { sha: 'Commit3', author: '', date: '', message: '' },
    ];

    test('Ignores dev-only readme', () => {
        const FILES = ['README.md', 'code/README.md', 'shared/README.md'];

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual([]);
    });

    test('Ignores other ignored files and folders', () => {
        const FILES = ['.vscode/settings.json', '.gitignore', '.husky/pre-commit', '.eslintrc', '.editorconfig'];

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual([]);
    });

    test('.actor/ changes trigger builds for broad-context actors', () => {
        const FILES = ['.actor/actor.json'];

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS.slice(0, 2));
    });

    test('Configured changelog is cosmetic for every actor, only on latest', () => {
        const FILES = ['CHANGELOG.md'];

        const actorsChangedNotLatest = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });
        expect(actorsChangedNotLatest).toEqual([]);

        const actorsChangedLatest = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: true,
            filepathsChanged: FILES,
            commits,
        });
        expect(actorsChangedLatest).toEqual(ACTOR_CONFIGS);
    });

    test('A changelog nested inside one actor own folder is excluded for sibling actors', () => {
        const FILES = ['actors/lukaskrivka_testing-github-integration-1/CHANGELOG.md'];

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: true,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual([ACTOR_CONFIGS[0]]);
    });

    test('Code updated, tests broad-context actors', () => {
        const FILES = ['code/src/main.ts', 'package.json'];

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS.slice(0, 2));
    });

    test('Specific Actor functionality configs updated', () => {
        const FILES = [
            'actors/lukaskrivka_testing-github-integration-1/.actor/actor.json',
            'standalone-actors/lukaskrivka_test-standalone/Dockerfile',
        ];

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual([ACTOR_CONFIGS[0], ACTOR_CONFIGS[2]]);
    });

    test('src/main.ts updated', () => {
        const FILES = ['src/main.ts'];

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: true,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS.slice(0, 2));
    });

    test('Actor folder, shared code and narrow-context actor updated', () => {
        const FILES = [
            'actors/lukaskrivka_testing-github-integration-1/.actor/actor.json',
            'code/src/main.ts',
            'standalone-actors/lukaskrivka_test-standalone/Dockerfile',
        ];

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS);
    });

    test('Specific Actor non-functional configs updated', () => {
        const FILES = [
            'actors/lukaskrivka_testing-github-integration-2/README.md',
            'standalone-actors/lukaskrivka_test-standalone/README.md',
        ];

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual([]);
    });

    test('Actor JSON changes in PR context trigger tests', () => {
        const FILES = ['actors/lukaskrivka_testing-github-integration-1/.actor/actor.json'];

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual([ACTOR_CONFIGS[0]]);
    });

    test('Actor JSON changes in latest context trigger builds', () => {
        const FILES = ['actors/lukaskrivka_testing-github-integration-1/.actor/actor.json'];

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

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual([ACTOR_CONFIGS[0]]);
    });

    test('JSON changes in two actor folders trigger both actors', () => {
        const FILES = [
            'actors/lukaskrivka_testing-github-integration-1/.actor/actor.json',
            'actors/lukaskrivka_testing-github-integration-2/.actor/input_schema.json',
        ];

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS.slice(0, 2));
    });

    test('Narrow-context actor JSON change in PR context triggers tests', () => {
        const FILES = ['standalone-actors/lukaskrivka_test-standalone/.actor/actor.json'];

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual([ACTOR_CONFIGS[2]]);
    });

    test('Google Maps real user-case that had undefined', () => {
        const FILES = [
            'actors/compass_Google-Maps-Reviews-Scraper/.actor/INPUT_SCHEMA.json',
            'actors/compass_crawler-google-places/.actor/INPUT_SCHEMA.json',
            'code/src/consts.ts',
            'code/src/crawlers/cheerio/routes.ts',
            'code/src/detail_page_handle.ts',
            'code/src/enqueue_places.ts',
            'code/src/helper-classes/initialize-all.ts',
            'code/src/helper-classes/stats.ts',
            'code/src/helper-classes/unmatched-categories.ts',
            'code/src/main.ts',
            'code/src/typedefs/general.ts',
            'code/src/utils/background-enqueue.ts',
        ];

        const ACTOR_CONFIGS_GOOGLE_MAPS: ActorConfig[] = [
            actorConfig(
                'compass/Google-Maps-Reviews-Scraper',
                'actors/compass_Google-Maps-Reviews-Scraper',
                'APIFY_TOKEN_COMPASS',
            ),
            actorConfig('compass/crawler-google-places', 'actors/compass_crawler-google-places', 'APIFY_TOKEN_COMPASS'),
            actorConfig('compass/easy-google-maps', 'actors/compass_easy-google-maps', 'APIFY_TOKEN_COMPASS'),
            actorConfig('compass/google-maps-extractor', 'actors/compass_google-maps-extractor', 'APIFY_TOKEN_COMPASS'),
            actorConfig('compass/google-places-api', 'actors/compass_google-places-api', 'APIFY_TOKEN_COMPASS'),
            actorConfig(
                'lukaskrivka/google-maps-with-contact-details',
                'actors/lukaskrivka_google-maps-with-contact-details',
                'APIFY_TOKEN_LUKASKRIVKA',
            ),
            actorConfig(
                'natasha.lekh/gas-prices-scraper',
                'actors/natasha.lekh_gas-prices-scraper',
                'APIFY_TOKEN_NATASHA_LEKH',
            ),
            actorConfig(
                'natasha.lekh/vegan-places-finder',
                'actors/natasha.lekh_vegan-places-finder',
                'APIFY_TOKEN_NATASHA_LEKH',
            ),
            actorConfig(
                'lukaskrivka/google-maps-scraper-orchestrator',
                'standalone-actors/lukaskrivka_google-maps-scraper-orchestrator',
                'APIFY_TOKEN_LUKASKRIVKA',
                'standalone-actors/lukaskrivka_google-maps-scraper-orchestrator',
            ),
        ];

        const actorsChanged = getChangedActors({
            actorConfigs: ACTOR_CONFIGS_GOOGLE_MAPS,
            isLatest: false,
            filepathsChanged: FILES,
            commits,
        });

        expect(actorsChanged).toEqual(ACTOR_CONFIGS_GOOGLE_MAPS.slice(0, 8));
    });
});
