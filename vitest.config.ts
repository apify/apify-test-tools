// eslint-disable-next-line import/no-default-export
export default {
    test: {
        // Runs in every test worker before any test file.
        setupFiles: ['./test/setup/isolate-git-env.ts'],
    },
};
