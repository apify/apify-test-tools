import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Vitest doesn't exclude `dist` by default
        exclude: [...configDefaults.exclude, 'dist/**'],
        globalSetup: ['./test/unit/bin/compiled-cli.ts'],
        // Git fixtures can exceed the default 10s when the whole suite runs in parallel.
        hookTimeout: 60_000,
    },
});
