# @apify/test-tools-cli

The `apify-test-tools` command behind the
[apify-test-tools](https://github.com/apify/apify-test-tools) reusable GitHub workflows: change
detection, Actor builds, releases, and test reports.

The workflows install this package at the exact version they pin, so CI needs nothing from your repo.
To run the commands locally:

```bash
npm i -D @apify/test-tools-cli
npx apify-test-tools --help
```

Platform tests themselves use the [`apify-test-tools`](https://www.npmjs.com/package/apify-test-tools)
library, which your repo installs and versions on its own.

Full documentation: https://github.com/apify/apify-test-tools#cli-apifytest-tools-cli
