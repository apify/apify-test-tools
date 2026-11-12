import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Vitest 4 and newer no longer exclude `dist` by default. The `.cli-test-*` folders are CLIs compiled for the
        // tests, test files included, see test/unit/bin/compiled-cli.ts.
        exclude: [...configDefaults.exclude, 'dist/**', '.cli-test-*/**'],
        // Some hooks compile the CLI or set up real git repositories, and with the whole suite running
        // in parallel the default 10s is too tight. A slower run is fine; a flaky one is not.
        hookTimeout: 60_000,
    },
});
