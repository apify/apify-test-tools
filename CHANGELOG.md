# Changelog

All notable changes to this project will be documented in this file.

## [0.7.0](https://github.com/apify/apify-test-tools/releases/tag/v0.7.0) (2026-04-10)

### 🚀 Features

- **testStandby:** Allow for custom paths and headers ([#77](https://github.com/apify/apify-test-tools/pull/77)) ([4e48329](https://github.com/apify/apify-test-tools/commit/4e4832973ebff4e97725e1abb0020887c874d347)) by [@JuanGalilea](https://github.com/JuanGalilea)

### 🐛 Bug Fixes

- Standby tests ([#76](https://github.com/apify/apify-test-tools/pull/76)) ([33cd89c](https://github.com/apify/apify-test-tools/commit/33cd89cf9e512f422704eeb8f6c46e4e2759a902)) by [@oklinov](https://github.com/oklinov)

### ⚡ Performance

- **bin:** Don&#x27;t test if we merge master into cosmetic only changes ([#78](https://github.com/apify/apify-test-tools/pull/78)) ([bc899eb](https://github.com/apify/apify-test-tools/commit/bc899eb550283862fbdc3c44a4fca6f682017c43)) by [@metalwarrior665](https://github.com/metalwarrior665)


## [0.6.3](https://github.com/apify/apify-test-tools/releases/tag/v0.6.3) (2026-04-06)

### 🐛 Bug Fixes

- **bin:** Case sensitivity in file path handling for git operations ([#75](https://github.com/apify/apify-test-tools/pull/75)) ([ae15cb6](https://github.com/apify/apify-test-tools/commit/ae15cb6a5e0b52d9332b7149b0b4f760cb41953a)) by [@metalwarrior665](https://github.com/metalwarrior665)


## [0.6.2](https://github.com/apify/apify-test-tools/releases/tag/v0.6.2) (2026-03-27)

### 🚀 Features

- Add delete-old-build that was present in previous testing system ([#71](https://github.com/apify/apify-test-tools/pull/71)) ([ad521a8](https://github.com/apify/apify-test-tools/commit/ad521a8242a81dd9f92285dc9a3bddaf98685db2)) by [@metalwarrior665](https://github.com/metalwarrior665)



## [0.6.1](https://github.com/apify/apify-test-tools/releases/tag/v0.6.1) (2026-03-26)

## [0.6.0](https://github.com/apify/apify-test-tools/releases/tag/v0.6.0) (2026-03-26)

### 🚀 Features

- Make slack notification explictly opt in ([#60](https://github.com/apify/apify-test-tools/pull/60)) ([32fda72](https://github.com/apify/apify-test-tools/commit/32fda72726896d90c7a1444977b87e4aa8e8d247)) by [@ruocco-l](https://github.com/ruocco-l), closes [#55](https://github.com/apify/apify-test-tools/issues/55)
- **bin:** Don&#x27;t test on nonfunctional changes in json files ([#56](https://github.com/apify/apify-test-tools/pull/56)) ([5f3c7c5](https://github.com/apify/apify-test-tools/commit/5f3c7c56c710a9120f894bdb6fd13855bf46f9f8)) by [@metalwarrior665](https://github.com/metalwarrior665), closes [#54](https://github.com/apify/apify-test-tools/issues/54)

### 🐛 Bug Fixes

- **bin:** In --base-commit, allow both sha string and Commit object ([#70](https://github.com/apify/apify-test-tools/pull/70)) ([cf01cd0](https://github.com/apify/apify-test-tools/commit/cf01cd0f3483502379415c48cfbf0f11665467ae)) by [@metalwarrior665](https://github.com/metalwarrior665), closes [#67](https://github.com/apify/apify-test-tools/issues/67)

### Debug

- Bump version to test beta release ([1322d31](https://github.com/apify/apify-test-tools/commit/1322d31873b6d43e16a68e97bdc358752f813f79)) by [@metalwarrior665](https://github.com/metalwarrior665)

# Changelog

## 0.5.5

fix: disable logs from actor.call

## 0.5.4

fix: make createStandbyTask work again (clean API object)

## 0.5.2

fix: file diffs between commits
feat: annotate runs with test names

## 0.5.1

fix: properly check on maxRetriesPerRequest
fix: change module resolution to nodenext and fix types

## 0.5.0

feat: feat: add maxRetriesPerRequest test

## 0.4.0

- feat: verbose message for toFinishWith failed assertions
- docs: update retry count default value to 1

## 0.3.0

### Lib

- feat: prettify logs and slack reports of tests and releases
- chore: update dependencies

## 0.2.4

### Lib

- fix: make sure standby task's name is unique

## 0.2.3

### Lib

- feat: add `runId` option to test tests
- fix: PPE pass won't override overall pass

## 0.2.2

### Cli

- enhancement: make build logs prettier

### Lib

- feat: add `runResult.getKeyValueStoreClient()` method

## 0.2.1

### Lib

- fix: fix: deconstruct input before returning it

## 0.2.0

### Lib

- feat: testing standby actors

### Cli

- fix: parsing commits
- feat: add `--workspace` cli option