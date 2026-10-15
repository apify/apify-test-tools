import prettier from 'eslint-config-prettier';

import apify from '@apify/eslint-config/ts.js';
import globals from 'globals';
import tsEslint from 'typescript-eslint';

// eslint-disable-next-line import/no-default-export
export default [
    { ignores: ['**/dist', 'eslint.config.mjs', '.github'] },
    ...apify,
    prettier,
    {
        languageOptions: {
            parser: tsEslint.parser,
            parserOptions: {
                project: 'tsconfig.json',
            },
            globals: {
                ...globals.node,
                ...globals.jest,
            },
        },
        plugins: {
            '@typescript-eslint': tsEslint.plugin,
        },
        rules: {
            // stdout is reserved for CLI results; diagnostics go through the shared logger.
            'no-console': 'error',
            // This was used heavily, I don't have string opinion so turning it off for now, feel free to refactor later
            'no-use-before-define': 'off',
            // Dev tooling (vitest, typescript, ...) lives in the root package.json and is shared by both
            // workspace packages, so check imports against the root as well as the nearest package.
            'import/no-extraneous-dependencies': [
                'error',
                {
                    packageDir: [
                        import.meta.dirname,
                        `${import.meta.dirname}/packages/lib`,
                        `${import.meta.dirname}/packages/cli`,
                    ],
                },
            ],
        },
    },
    // Published code may only import what its own package.json declares, so the library can't
    // quietly start depending on something only the CLI installs, or the other way round.
    ...['lib', 'cli'].map((pkg) => ({
        files: [`packages/${pkg}/index.ts`, `packages/${pkg}/src/**/*.ts`],
        rules: {
            'import/no-extraneous-dependencies': ['error', { packageDir: `${import.meta.dirname}/packages/${pkg}` }],
        },
    })),
    {
        files: ['packages/lib/index.ts', 'packages/lib/src/**/*.ts'],
        rules: {
            // The importable library has its own diagnostics, independent of CLI logging.
            'no-console': ['error', { allow: ['warn', 'error'] }],
        },
    },
];
