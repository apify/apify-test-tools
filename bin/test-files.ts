import picomatch from 'picomatch';

export const DEFAULT_TEST_FILES_GLOB = 'test/platform/**';

export type TestFileMatcher = (filePath: string) => boolean;

export const createTestFileMatcher = (testFilesGlob: string = DEFAULT_TEST_FILES_GLOB): TestFileMatcher => {
    const isMatch = picomatch(testFilesGlob, { nocase: true, dot: true });
    // Only the path: picomatch treats a second argument (e.g. an index from Array.filter) as returnObject
    return (filePath) => isMatch(filePath);
};
