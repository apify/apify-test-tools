import { describe, expect,it } from 'vitest';

import { GIT_FORMAT_SEPARATOR, parseCommit } from '../../bin/git.js';

describe('parseCommit', () => {
    describe('valid commit strings', () => {
        it('should parse a basic commit string correctly', () => {
            const commitString = `abc123${GIT_FORMAT_SEPARATOR}John Doe<john@example.com>${GIT_FORMAT_SEPARATOR}Mon, 25 Dec 2023 10:30:00 +0100${GIT_FORMAT_SEPARATOR}Add new feature`;

            const result = parseCommit(commitString);

            expect(result).toEqual({
                sha: 'abc123',
                author: 'John Doe<john@example.com>',
                date: 'Mon, 25 Dec 2023 10:30:00 +0100',
                message: 'Add new feature',
            });
        });

        it('should parse commit with double quotes in message', () => {
            const commitString = `def456${GIT_FORMAT_SEPARATOR}Jane Smith<jane@example.com>${GIT_FORMAT_SEPARATOR}Tue, 26 Dec 2023 14:15:00 +0100${GIT_FORMAT_SEPARATOR}test: commit with double quotes: "`;

            const result = parseCommit(commitString);

            expect(result).toEqual({
                sha: 'def456',
                author: 'Jane Smith<jane@example.com>',
                date: 'Tue, 26 Dec 2023 14:15:00 +0100',
                message: 'test: commit with double quotes: "',
            });
        });

        it('should parse commit with special characters and Unicode', () => {
            const commitString = `jkl012${GIT_FORMAT_SEPARATOR}María García<maria@example.com>${GIT_FORMAT_SEPARATOR}Thu, 28 Dec 2023 16:20:00 +0100${GIT_FORMAT_SEPARATOR}Add émojis 🚀 and "special" chars`;

            const result = parseCommit(commitString);

            expect(result).toEqual({
                sha: 'jkl012',
                author: 'María García<maria@example.com>',
                date: 'Thu, 28 Dec 2023 16:20:00 +0100',
                message: 'Add émojis 🚀 and "special" chars',
            });
        });

        it('should parse commit with empty message', () => {
            const commitString = `mno345${GIT_FORMAT_SEPARATOR}Test User<test@example.com>${GIT_FORMAT_SEPARATOR}Fri, 29 Dec 2023 11:00:00 +0100${GIT_FORMAT_SEPARATOR}`;

            const result = parseCommit(commitString);

            expect(result).toEqual({
                sha: 'mno345',
                author: 'Test User<test@example.com>',
                date: 'Fri, 29 Dec 2023 11:00:00 +0100',
                message: '',
            });
        });
    });

    describe('invalid commit strings', () => {
        it('should throw error for commit string with too few parts', () => {
            const commitString = `abc123${GIT_FORMAT_SEPARATOR}John Doe<john@example.com>${GIT_FORMAT_SEPARATOR}Mon, 25 Dec 2023 10:30:00 +0100`;

            expect(() => parseCommit(commitString)).toThrow(`Failed to parse commit string: ${commitString}`);
        });

        it('should throw error for commit string with too many parts', () => {
            const commitString = `abc123${GIT_FORMAT_SEPARATOR}John Doe<john@example.com>${GIT_FORMAT_SEPARATOR}Mon, 25 Dec 2023 10:30:00 +0100${GIT_FORMAT_SEPARATOR}Add feature${GIT_FORMAT_SEPARATOR}extra part`;

            expect(() => parseCommit(commitString)).toThrow(`Failed to parse commit string: ${commitString}`);
        });
    });
});
