import { describe, expect, it } from 'vitest';

import { ACTOR_NAME, USERNAME } from '@apify/consts';

import { ACTOR_FULL_NAME_REGEX } from '../../../../../../bin/utils/config/structures/base.js';

// ACTOR_FULL_NAME_REGEX is spliced together from two platform constants by stripping their anchors
// and joining them with a "/". These tests are about the splice, not about re-testing the platform's
// own rules: an anchor left behind, an anchor stripped too eagerly, or the actor-name alternation
// losing its parentheses would all produce a regex that still looks plausible and matches the wrong
// things. The cases below are the ones that tell those failures apart.
describe('ACTOR_FULL_NAME_REGEX', () => {
    it.each([
        ['apify/web-scraper'],
        ['myteam/shopify'],
        ['my.team/web-scraper'],
        ['my-team/shopify'],
        ['my_team/a1'],
        // ACTOR_NAME's first alternative — a single character — is a legal actor name on its own.
        ['myteam/a'],
        ['myteam/a--b'],
    ])('accepts %s', (fullName) => {
        expect(ACTOR_FULL_NAME_REGEX.test(fullName)).toBe(true);
    });

    it.each([
        ['there is no slash', 'shopify'],
        ['the owner half is empty', '/shopify'],
        ['the actor half is empty', 'myteam/'],
        ['there are two slashes', 'myteam//shopify'],
        ['there is a third segment', 'myteam/shopify/extra'],
        ['the owner holds a space', 'my team/shopify'],
        ['the actor name starts with a hyphen', 'myteam/-shopify'],
        ['the actor name ends with a hyphen', 'myteam/shopify-'],
        ['the actor name holds an underscore', 'myteam/web_scraper'],
        ['the actor name holds a dot', 'myteam/web.scraper'],
    ])('rejects a name where %s', (_name, fullName) => {
        expect(ACTOR_FULL_NAME_REGEX.test(fullName)).toBe(false);
    });

    // Both halves arrive anchored and get de-anchored so they can be joined; the composed regex has to
    // put the anchors back. Without them these all match on a substring.
    it.each([
        ['leading text', 'see myteam/shopify'],
        ['trailing text', 'myteam/shopify here'],
        ['a leading newline', '\nmyteam/shopify'],
        ['a trailing newline', 'myteam/shopify\n'],
        ['surrounding whitespace', ' myteam/shopify '],
    ])('matches the whole string, so it rejects %s', (_name, fullName) => {
        expect(ACTOR_FULL_NAME_REGEX.test(fullName)).toBe(false);
    });

    // ACTOR_NAME's source is an alternation, "(A|B)". It survives the splice only because the platform
    // wrote it parenthesized — lose those parens and the regex becomes "^owner/A|B$", where the "B"
    // branch matches a bare actor name with no owner at all.
    it('keeps the actor-name alternation from swallowing the owner half', () => {
        expect(ACTOR_NAME.REGEX.source).toMatch(/^\^\(.*\)\$$/);
        expect(ACTOR_FULL_NAME_REGEX.test('shopify')).toBe(false);
        expect(ACTOR_FULL_NAME_REGEX.test('a')).toBe(false);
    });

    // The owner half carries a {min,max} quantifier, the one part of either source that a sloppy strip
    // could eat. Bounds come from the constants so this stays honest if the platform moves them.
    it("enforces the platform's username length bounds", () => {
        const owner = (length: number) => `${'a'.repeat(length)}/shopify`;

        expect(ACTOR_FULL_NAME_REGEX.test(owner(USERNAME.MIN_LENGTH))).toBe(true);
        expect(ACTOR_FULL_NAME_REGEX.test(owner(USERNAME.MIN_LENGTH - 1))).toBe(false);
        expect(ACTOR_FULL_NAME_REGEX.test(owner(USERNAME.MAX_LENGTH))).toBe(true);
        expect(ACTOR_FULL_NAME_REGEX.test(owner(USERNAME.MAX_LENGTH + 1))).toBe(false);
    });

    // `.source` carries the pattern and none of the flags, so the flags have to be re-applied by hand.
    // USERNAME.REGEX is declared /i and the platform does accept "MyTeam" as a username; drop that on
    // the way here and the owner half silently becomes stricter than the thing it was copied from.
    it('accepts either half in any case, the way the platform does', () => {
        expect(USERNAME.REGEX.flags).toContain('i');
        expect(ACTOR_FULL_NAME_REGEX.flags).toContain('i');

        expect(ACTOR_FULL_NAME_REGEX.test('myteam/Shopify')).toBe(true);
        expect(ACTOR_FULL_NAME_REGEX.test('MyTeam/shopify')).toBe(true);
    });
});
