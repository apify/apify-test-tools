import type { MockInstance } from 'vitest';
import { beforeEach, describe, expect, it, test, vi } from 'vitest';

import { isCosmeticOnlyJsonSchemaChange } from '../../../bin/diff-json-schema.js';
import * as Utils from '../../../bin/utils.js';

const commits = [
    { sha: 'Commit1', author: '', date: '', message: '' },
    { sha: 'Commit3', author: '', date: '', message: '' },
];

describe('isCosmeticOnlyJsonSchemaChange', () => {
    let gitCommandSpy: MockInstance;

    beforeEach(() => {
        gitCommandSpy = vi.spyOn(Utils, 'spawnCommandInGhWorkspace');
    });

    const mockGitCalls = (oldJson: string, newJson: string) => {
        gitCommandSpy
            .mockReturnValueOnce(oldJson)
            .mockReturnValueOnce(newJson);
    };

    test('returns true when nothing changed', () => {
        const json = JSON.stringify({ type: 'string', title: 'My field' });
        mockGitCalls(json, json);
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(true);
    });

    test('returns true when only title changes', () => {
        mockGitCalls(
            JSON.stringify({ type: 'string', title: 'Old title' }),
            JSON.stringify({ type: 'string', title: 'New title' }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(true);
    });

    test('returns true when only description changes', () => {
        mockGitCalls(
            JSON.stringify({ type: 'string', description: 'Old desc' }),
            JSON.stringify({ type: 'string', description: 'New desc' }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(true);
    });

    test('returns true when only example changes', () => {
        mockGitCalls(
            JSON.stringify({ type: 'string', example: 'foo' }),
            JSON.stringify({ type: 'string', example: 'bar' }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(true);
    });

    test('returns true when only enumTitles changes', () => {
        mockGitCalls(
            JSON.stringify({ type: 'string', enum: ['a', 'b'], enumTitles: ['Option A', 'Option B'] }),
            JSON.stringify({ type: 'string', enum: ['a', 'b'], enumTitles: ['Choice A', 'Choice B'] }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(true);
    });

    test('returns true when only sectionCaption changes', () => {
        mockGitCalls(
            JSON.stringify({ sectionCaption: 'Old caption' }),
            JSON.stringify({ sectionCaption: 'New caption' }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(true);
    });

    test('returns true when only sectionDescription changes', () => {
        mockGitCalls(
            JSON.stringify({ sectionDescription: 'Old' }),
            JSON.stringify({ sectionDescription: 'New' }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(true);
    });

    test('returns false when a functional field (type) changes', () => {
        mockGitCalls(
            JSON.stringify({ type: 'string', title: 'My field' }),
            JSON.stringify({ type: 'integer', title: 'My field' }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(false);
    });

    test('returns false when a functional field is added', () => {
        mockGitCalls(
            JSON.stringify({ title: 'My field' }),
            JSON.stringify({ title: 'My field', type: 'string' }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(false);
    });

    test('returns false when a functional field is removed', () => {
        mockGitCalls(
            JSON.stringify({ type: 'string', title: 'My field' }),
            JSON.stringify({ title: 'My field' }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(false);
    });

    test('returns true when non-functional fields change at nested level (input schema properties)', () => {
        mockGitCalls(
            JSON.stringify({
                type: 'object',
                properties: {
                    myField: { type: 'string', title: 'Old title', description: 'Old desc', example: 'old' },
                },
            }),
            JSON.stringify({
                type: 'object',
                properties: {
                    myField: { type: 'string', title: 'New title', description: 'New desc', example: 'new' },
                },
            }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(true);
    });

    test('returns false when a functional nested field changes alongside non-functional ones', () => {
        mockGitCalls(
            JSON.stringify({
                type: 'object',
                properties: { myField: { type: 'string', title: 'Old title' } },
            }),
            JSON.stringify({
                type: 'object',
                properties: { myField: { type: 'integer', title: 'New title' } },
            }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(false);
    });

    test('returns false when a new property is added to input schema', () => {
        mockGitCalls(
            JSON.stringify({ properties: { fieldA: { type: 'string' } } }),
            JSON.stringify({ properties: { fieldA: { type: 'string' }, fieldB: { type: 'integer' } } }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(false);
    });

    test('returns false when a property is removed from input schema', () => {
        mockGitCalls(
            JSON.stringify({ properties: { fieldA: { type: 'string' }, fieldB: { type: 'integer' } } }),
            JSON.stringify({ properties: { fieldA: { type: 'string' } } }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(false);
    });

    test('returns false when invalid JSON in old content', () => {
        mockGitCalls('not json', '{}');
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(false);
    });

    test('returns false when invalid JSON in new content', () => {
        mockGitCalls('{}', 'not json');
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(false);
    });

    test('returns false when array content changes (not under a non-functional key)', () => {
        mockGitCalls(
            JSON.stringify({ enum: [1, 2, 3] }),
            JSON.stringify({ enum: [1, 2, 4] }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(false);
    });

    test('returns true when example array changes (non-functional key)', () => {
        mockGitCalls(
            JSON.stringify({ type: 'array', example: [1, 2, 3] }),
            JSON.stringify({ type: 'array', example: [4, 5, 6] }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(true);
    });

    test('returns true for a realistic actor.json with only title/description change', () => {
        mockGitCalls(
            JSON.stringify({ actorSpecification: 1, name: 'my-actor', title: 'Old Title', description: 'Old description', version: '1.0' }),
            JSON.stringify({ actorSpecification: 1, name: 'my-actor', title: 'New Title', description: 'New description', version: '1.0' }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(true);
    });

    test('returns true when fields under properties are reordered', () => {
        mockGitCalls(
            JSON.stringify({
                type: 'object',
                properties: { fieldA: { type: 'string' }, fieldB: { type: 'integer' }, fieldC: { type: 'boolean' } },
            }),
            JSON.stringify({
                type: 'object',
                properties: { fieldC: { type: 'boolean' }, fieldA: { type: 'string' }, fieldB: { type: 'integer' } },
            }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(true);
    });

    test('returns false for a realistic actor.json with version change', () => {
        mockGitCalls(
            JSON.stringify({ actorSpecification: 1, name: 'my-actor', title: 'My Actor', version: '1.0' }),
            JSON.stringify({ actorSpecification: 1, name: 'my-actor', title: 'My Actor', version: '1.1' }),
        );
        expect(isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json')).toBe(false);
    });

    it('uses correct git refs: first-commit parent for old, last commit for new', () => {
        const json = JSON.stringify({});
        mockGitCalls(json, json);
        isCosmeticOnlyJsonSchemaChange(commits, 'actors/foo/actor.json');
        expect(gitCommandSpy).toHaveBeenCalledWith('git show Commit1~:actors/foo/actor.json');
        expect(gitCommandSpy).toHaveBeenCalledWith('git show Commit3:actors/foo/actor.json');
    });
});
