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
