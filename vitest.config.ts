import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globalSetup: ['test/compile-cli.global-setup.ts'],
        // The default 10s is too tight for hooks that set up real git repositories while the whole
        // suite runs in parallel. A slower run is fine; a flaky one is not.
        hookTimeout: 60_000,
    },
});
