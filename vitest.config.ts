import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Some hooks compile the CLI or set up real git repositories, and with the whole suite running
        // in parallel the default 10s is too tight. A slower run is fine; a flaky one is not.
        hookTimeout: 60_000,
    },
});
