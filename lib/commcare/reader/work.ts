/**
 * The work limit of one reading: a count of work (`workMeter.ts`), never a
 * clock, that is a function of the size of the source alone, so the same app
 * reads to the same verdict on any instance. A reading that would pass it
 * stops where it passes it and is an account of one finding at the app,
 * `too-intricate`: an app whose reading takes more work than its size gives
 * Nova room for, which no byte cap catches, since bytes bound work only where
 * the work is linear.
 *
 * The size is `sourceCharacters`: one a character of every key and string of
 * the source as HQ serves it (its forms' XML among them, in `_attachments`)
 * and one a value. The limit is `READ_WORK_BASE` and
 * `READ_WORK_PER_SOURCE_CHARACTER` a character, both set from one
 * measurement at four times the most observed: the most units any reading of
 * a document the proof lane publishes spent (small documents, whose fixed
 * work their size does not cover) gives the base, and the most units a
 * character any reading of a retained base made in CommCare HQ, of a fuzz
 * document `lib/deployment/reading/__tests__/canonReadBack.fuzz.test.ts`
 * reads, or of the cap test's source spent gives the rate.
 * `__tests__/readWorkLimit.test.ts` holds every retained base and published
 * document under a quarter of its limit, so a change that moves a reading's
 * work toward the limit is seen in ordinary CI, and the fuzz reads every
 * document it draws under the limit itself.
 */

/** Units every reading may spend whatever its size: four times the 1,911,436 units the reading
 *  of the most work among the documents the proof lane publishes spent
 *  (`targeted-datetime-saved`, 71,482 characters), rounded up. */
export const READ_WORK_BASE = 8_000_000;

/** Units a reading may spend a character of its source: four times the 18.6 units a character
 *  the reading of the most work a character spent (a record-expression fuzz document of
 *  250,065 characters; the most among the retained bases was 16.1, `hq-expressions`, and a
 *  whole request at the cap spent 1.9), rounded up. */
export const READ_WORK_PER_SOURCE_CHARACTER = 75;

/** The limit of a reading of a source of `characters`. */
export function readWorkLimit(characters: number): number {
	return READ_WORK_BASE + READ_WORK_PER_SOURCE_CHARACTER * characters;
}

/**
 * The size of `value` the limit is a function of: a character of every key
 * and string, and one a value. A walk with its own stack, so a deep source
 * costs no frame of the caller's.
 */
export function sourceCharacters(value: unknown): number {
	let characters = 0;
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const at = pending.pop();
		characters += 1;
		if (typeof at === "string") characters += at.length;
		else if (Array.isArray(at)) for (const item of at) pending.push(item);
		else if (typeof at === "object" && at !== null)
			for (const [key, item] of Object.entries(at)) {
				characters += key.length;
				pending.push(item);
			}
	}
	return characters;
}
