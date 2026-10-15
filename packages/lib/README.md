# apify-test-tools

Vitest helpers for platform tests of Apify Actors: `testActor`, `describe`, `testStandbyActor`, and
custom matchers such as `toFinishWith`.

```bash
npm i -D apify-test-tools
```

The CI commands (`build`, `release`, `report-tests`, ...) are in a separate package,
[`@apify/test-tools-cli`](https://www.npmjs.com/package/@apify/test-tools-cli). The reusable workflows
install it themselves, so you only need it to run those commands locally.

Full documentation: https://github.com/apify/apify-test-tools#readme
