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
        },
    },
    {
        files: ['lib/**/*.ts'],
        rules: {
            // The importable library has its own diagnostics, independent of CLI logging.
            'no-console': ['error', { allow: ['warn', 'error'] }],
        },
    },
];
