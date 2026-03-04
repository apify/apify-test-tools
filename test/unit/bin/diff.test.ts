import { beforeEach, describe, expect, it, MockInstance, test, vi } from 'vitest';
import { isNonfunctionalJsonChange, findFilesWithNonfunctionalChanges } from '../../../bin/diff.js';
import * as Utils from '../../../bin/utils.js';

describe('isNonfunctionalJsonChange', () => {
    test('returns true when nothing changed', () => {
        const json = JSON.stringify({ type: 'string', title: 'My field' });
        expect(isNonfunctionalJsonChange(json, json)).toBe(true);
    });

    test('returns true when only title changes', () => {
        const old = JSON.stringify({ type: 'string', title: 'Old title' });
        const next = JSON.stringify({ type: 'string', title: 'New title' });
        expect(isNonfunctionalJsonChange(old, next)).toBe(true);
    });

    test('returns true when only description changes', () => {
        const old = JSON.stringify({ type: 'string', description: 'Old desc' });
        const next = JSON.stringify({ type: 'string', description: 'New desc' });
        expect(isNonfunctionalJsonChange(old, next)).toBe(true);
    });

    test('returns true when only example changes', () => {
        const old = JSON.stringify({ type: 'string', example: 'foo' });
        const next = JSON.stringify({ type: 'string', example: 'bar' });
        expect(isNonfunctionalJsonChange(old, next)).toBe(true);
    });

    test('returns true when only enumTitles changes', () => {
        const old = JSON.stringify({ type: 'string', enum: ['a', 'b'], enumTitles: ['Option A', 'Option B'] });
        const next = JSON.stringify({ type: 'string', enum: ['a', 'b'], enumTitles: ['Choice A', 'Choice B'] });
        expect(isNonfunctionalJsonChange(old, next)).toBe(true);
    });

    test('returns true when only sectionCaption changes', () => {
        const old = JSON.stringify({ sectionCaption: 'Old caption' });
        const next = JSON.stringify({ sectionCaption: 'New caption' });
        expect(isNonfunctionalJsonChange(old, next)).toBe(true);
    });

    test('returns true when only sectionDescription changes', () => {
        const old = JSON.stringify({ sectionDescription: 'Old' });
        const next = JSON.stringify({ sectionDescription: 'New' });
        expect(isNonfunctionalJsonChange(old, next)).toBe(true);
    });

    test('returns false when a functional field (type) changes', () => {
        const old = JSON.stringify({ type: 'string', title: 'My field' });
        const next = JSON.stringify({ type: 'integer', title: 'My field' });
        expect(isNonfunctionalJsonChange(old, next)).toBe(false);
    });

    test('returns false when a functional field is added', () => {
        const old = JSON.stringify({ title: 'My field' });
        const next = JSON.stringify({ title: 'My field', type: 'string' });
        expect(isNonfunctionalJsonChange(old, next)).toBe(false);
    });

    test('returns false when a functional field is removed', () => {
        const old = JSON.stringify({ type: 'string', title: 'My field' });
        const next = JSON.stringify({ title: 'My field' });
        expect(isNonfunctionalJsonChange(old, next)).toBe(false);
    });

    test('returns true when non-functional fields change at nested level (input schema properties)', () => {
        const old = JSON.stringify({
            type: 'object',
            properties: {
                myField: { type: 'string', title: 'Old title', description: 'Old desc', example: 'old' },
            },
        });
        const next = JSON.stringify({
            type: 'object',
            properties: {
                myField: { type: 'string', title: 'New title', description: 'New desc', example: 'new' },
            },
        });
        expect(isNonfunctionalJsonChange(old, next)).toBe(true);
    });

    test('returns false when a functional nested field changes alongside non-functional ones', () => {
        const old = JSON.stringify({
            type: 'object',
            properties: {
                myField: { type: 'string', title: 'Old title' },
            },
        });
        const next = JSON.stringify({
            type: 'object',
            properties: {
                myField: { type: 'integer', title: 'New title' },
            },
        });
        expect(isNonfunctionalJsonChange(old, next)).toBe(false);
    });

    test('returns false when a new property is added to input schema', () => {
        const old = JSON.stringify({ properties: { fieldA: { type: 'string' } } });
        const next = JSON.stringify({ properties: { fieldA: { type: 'string' }, fieldB: { type: 'integer' } } });
        expect(isNonfunctionalJsonChange(old, next)).toBe(false);
    });

    test('returns false when a property is removed from input schema', () => {
        const old = JSON.stringify({ properties: { fieldA: { type: 'string' }, fieldB: { type: 'integer' } } });
        const next = JSON.stringify({ properties: { fieldA: { type: 'string' } } });
        expect(isNonfunctionalJsonChange(old, next)).toBe(false);
    });

    test('returns false when invalid JSON is provided', () => {
        expect(isNonfunctionalJsonChange('not json', '{}')).toBe(false);
        expect(isNonfunctionalJsonChange('{}', 'not json')).toBe(false);
    });

    test('returns false when array content changes (not under a non-functional key)', () => {
        const old = JSON.stringify({ enum: [1, 2, 3] });
        const next = JSON.stringify({ enum: [1, 2, 4] });
        expect(isNonfunctionalJsonChange(old, next)).toBe(false);
    });

    test('returns true when example array changes (non-functional key)', () => {
        const old = JSON.stringify({ type: 'array', example: [1, 2, 3] });
        const next = JSON.stringify({ type: 'array', example: [4, 5, 6] });
        expect(isNonfunctionalJsonChange(old, next)).toBe(true);
    });

    test('returns true for a realistic actor.json with only title/description change', () => {
        const old = JSON.stringify({
            actorSpecification: 1,
            name: 'my-actor',
            title: 'Old Title',
            description: 'Old description',
            version: '1.0',
        });
        const next = JSON.stringify({
            actorSpecification: 1,
            name: 'my-actor',
            title: 'New Title',
            description: 'New description',
            version: '1.0',
        });
        expect(isNonfunctionalJsonChange(old, next)).toBe(true);
    });

    test('returns false for a realistic actor.json with version change', () => {
        const old = JSON.stringify({
            actorSpecification: 1,
            name: 'my-actor',
            title: 'My Actor',
            version: '1.0',
        });
        const next = JSON.stringify({
            actorSpecification: 1,
            name: 'my-actor',
            title: 'My Actor',
            version: '1.1',
        });
        expect(isNonfunctionalJsonChange(old, next)).toBe(false);
    });
});

describe('findFilesWithNonfunctionalChanges', () => {
    const commits = [
        { sha: 'Commit1', author: '', date: '', message: '' },
        { sha: 'Commit3', author: '', date: '', message: '' },
    ];

    const oldJson = JSON.stringify({ type: 'string', title: 'Old title' });
    const newJsonNonfunctional = JSON.stringify({ type: 'string', title: 'New title' });
    const newJsonFunctional = JSON.stringify({ type: 'integer', title: 'New title' });

    let gitCommandSpy: MockInstance;

    beforeEach(() => {
        gitCommandSpy = vi.spyOn(Utils, 'spawnCommandInGhWorkspace').mockReturnValue(oldJson);
    });

    it('returns empty set when commits is empty', () => {
        const result = findFilesWithNonfunctionalChanges([], ['actors/foo_bar/actor.json']);
        expect(result).toEqual(new Set());
        expect(gitCommandSpy).not.toHaveBeenCalled();
    });

    it('returns empty set when no JSON files in filepaths', () => {
        const result = findFilesWithNonfunctionalChanges(commits, ['src/main.ts', 'README.md']);
        expect(result).toEqual(new Set());
        expect(gitCommandSpy).not.toHaveBeenCalled();
    });

    it('includes file when only non-functional fields changed', () => {
        gitCommandSpy
            .mockReturnValueOnce(oldJson)
            .mockReturnValueOnce(newJsonNonfunctional);

        const result = findFilesWithNonfunctionalChanges(commits, ['actors/foo_bar/actor.json']);
        expect(result).toEqual(new Set(['actors/foo_bar/actor.json']));
    });

    it('excludes file when functional fields changed', () => {
        gitCommandSpy
            .mockReturnValueOnce(oldJson)
            .mockReturnValueOnce(newJsonFunctional);

        const result = findFilesWithNonfunctionalChanges(commits, ['actors/foo_bar/actor.json']);
        expect(result).toEqual(new Set());
    });

    it('excludes file when git throws (e.g. new file not found in old ref)', () => {
        gitCommandSpy.mockImplementationOnce(() => { throw new Error('fatal: path not found'); });

        const result = findFilesWithNonfunctionalChanges(commits, ['actors/foo_bar/actor.json']);
        expect(result).toEqual(new Set());
    });

    it('handles multiple files, returning correct subset', () => {
        gitCommandSpy
            .mockReturnValueOnce(oldJson)              // old for actor.json
            .mockReturnValueOnce(newJsonNonfunctional) // new for actor.json (nonfunctional only)
            .mockReturnValueOnce(oldJson)              // old for input_schema.json
            .mockReturnValueOnce(newJsonFunctional);   // new for input_schema.json (functional change)

        const result = findFilesWithNonfunctionalChanges(commits, [
            'actors/foo_bar/actor.json',
            'actors/foo_bar/input_schema.json',
        ]);
        expect(result).toEqual(new Set(['actors/foo_bar/actor.json']));
    });

    it('normalizes file paths to lowercase in result', () => {
        gitCommandSpy
            .mockReturnValueOnce(oldJson)
            .mockReturnValueOnce(newJsonNonfunctional);

        const result = findFilesWithNonfunctionalChanges(commits, ['actors/foo_bar/Actor.JSON']);
        expect(result).toEqual(new Set(['actors/foo_bar/actor.json']));
    });

    it('uses correct git refs: first-commit parent for old, last commit for new', () => {
        gitCommandSpy
            .mockReturnValueOnce(oldJson)
            .mockReturnValueOnce(newJsonNonfunctional);

        findFilesWithNonfunctionalChanges(commits, ['actors/foo_bar/actor.json']);

        expect(gitCommandSpy).toHaveBeenCalledWith('git show Commit1~:actors/foo_bar/actor.json');
        expect(gitCommandSpy).toHaveBeenCalledWith('git show Commit3:actors/foo_bar/actor.json');
    });

    it('skips non-JSON files and only processes JSON files inside actors folders', () => {
        gitCommandSpy
            .mockReturnValueOnce(oldJson)
            .mockReturnValueOnce(newJsonNonfunctional);

        const result = findFilesWithNonfunctionalChanges(commits, [
            'actors/foo_bar/main.ts',
            'actors/foo_bar/actor.json',
            'actors/foo_bar/README.md',
            'package.json',           // top-level JSON — should be ignored
        ]);
        expect(result).toEqual(new Set(['actors/foo_bar/actor.json']));
        expect(gitCommandSpy).toHaveBeenCalledTimes(2); // only for the actor JSON file
    });

    it('also checks JSON files inside standalone-actors', () => {
        gitCommandSpy
            .mockReturnValueOnce(oldJson)
            .mockReturnValueOnce(newJsonNonfunctional);

        const result = findFilesWithNonfunctionalChanges(commits, [
            'standalone-actors/foo_bar/actor.json',
        ]);
        expect(result).toEqual(new Set(['standalone-actors/foo_bar/actor.json']));
    });

    it('ignores top-level JSON files like package.json', () => {
        const result = findFilesWithNonfunctionalChanges(commits, ['package.json', 'tsconfig.json']);
        expect(result).toEqual(new Set());
        expect(gitCommandSpy).not.toHaveBeenCalled();
    });
});
