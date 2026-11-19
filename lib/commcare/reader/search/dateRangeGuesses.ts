/**
 * The properties a reading types `date` only because a simple date range
 * Search field reads them and nothing else types them: the gate takes a date
 * range field over a date or a date and time (`SEARCH_INPUT_TYPE_PROPERTY_TYPES`),
 * and the field's print is HQ's prompt alone, which says neither. A record
 * slot that compares such a property with a date and time says which
 * (`expressions/index.ts::withComparedTypes`), and the comparison's type is
 * the property's.
 */
import type { ReadContext } from "../context";

const GUESSES = new WeakMap<ReadContext, ReadonlySet<string>>();

/** The key of a property among the guesses. */
export function guessKey(caseType: string, property: string): string {
	return JSON.stringify([caseType, property]);
}

/** Records the reading's guesses, once, as the search stage declares them. */
export function noteDateRangeGuesses(
	ctx: ReadContext,
	guesses: ReadonlySet<string>,
): void {
	GUESSES.set(ctx, guesses);
}

/** The reading's guesses, by `guessKey`. */
export function dateRangeGuesses(ctx: ReadContext): ReadonlySet<string> {
	return GUESSES.get(ctx) ?? new Set();
}
