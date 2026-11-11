import { ACTOR_NAME, APIFY_ID_REGEX, USERNAME } from '@apify/consts';

function stripRegexAnchor(regex: string): string {
    return regex.replace(/^\^/, '').replace(/\$$/, '');
}

/** An Actor's full name, `owner/name`, by the platform's own rules for usernames and Actor names. */
export const ACTOR_FULL_NAME_REGEX = new RegExp(
    `^${stripRegexAnchor(USERNAME.REGEX.source)}/${stripRegexAnchor(ACTOR_NAME.REGEX.source)}$`,
    USERNAME.REGEX.flags + ACTOR_NAME.REGEX.flags,
);

export const isActorFullName = (actorId: string): boolean => ACTOR_FULL_NAME_REGEX.test(actorId);

/** A raw platform ID, 17 alphanumeric characters. */
export const isActorRawId = (actorId: string): boolean => APIFY_ID_REGEX.test(actorId);
