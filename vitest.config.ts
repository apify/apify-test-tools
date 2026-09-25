import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // The e2e fixture is a consumer repo with platform tests of its own; they run in the sandbox
        // repo against apify-test-tools as an installed package, never from here. The harness's
        // working copies are clones of it.
        exclude: [...configDefaults.exclude, 'e2e/fixture/**', 'e2e/.work/**'],
    },
});
