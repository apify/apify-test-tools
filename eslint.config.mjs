import prettier from 'eslint-config-prettier';

import apify from '@apify/eslint-config/ts.js';
import globals from 'globals';
import tsEslint from 'typescript-eslint';

// eslint-disable-next-line import/no-default-export
export default [
    { ignores: ['**/dist', 'eslint.config.mjs', 'vitest.config.ts', '.github', 'e2e/fixture', 'e2e/.work'] },
    ...apify,
    prettier,
    {
        languageOptions: {
            parser: tsEslint.parser,
            parserOptions: {
                project: ['tsconfig.json', 'e2e/tsconfig.json'],
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
            'no-console': 0,
            // This was used heavily, I don't have string opinion so turning it off for now, feel free to refactor later
            'no-use-before-define': 'off',
        },
    },
];
