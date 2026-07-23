/**
 * Shared value contract for the scalar case-operation facets that CommCare
 * stores in fixed-width columns (`case_name` and `owner_id`).
 *
 * CommCare Core trims XML whitespace at both create and update time and then
 * rejects either value above 255 Java UTF-16 code units. Nova normalizes the
 * emitted calculate itself so HQ, Core, and the future S06 executor observe
 * one value. The explicit character class is Java regex `\s`'s default set;
 * unlike JavaScript `\s`, it deliberately does not add Unicode whitespace.
 */
export const MAX_CASE_OPERATION_TEXT_LENGTH = 255;

const CASE_OPERATION_BOUNDARY_WHITESPACE = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;

export type PreparedCaseOperationTextValue =
	| { readonly ok: true; readonly value: string }
	| {
			readonly ok: false;
			readonly value: string;
			readonly reason: "blank" | "too-long";
	  };

/** Normalize one evaluated name/rename/owner value exactly once before write. */
export function normalizeCaseOperationTextValue(value: string): string {
	return value.replace(CASE_OPERATION_BOUNDARY_WHITESPACE, "");
}

/**
 * Normalize and validate a name/rename/owner result before any case write.
 *
 * All explicitly authored values are nonblank. `unowned` is represented by
 * `-`, so accepting an empty owner would introduce a second, ambiguous way to
 * express the same intent. Create names and renames are also nonblank because
 * Nova's `cases.case_name` invariant is nonempty even though the legacy case
 * wire itself permits an empty name.
 */
export function prepareCaseOperationTextValue(
	value: string,
): PreparedCaseOperationTextValue {
	const normalized = normalizeCaseOperationTextValue(value);
	if (normalized.length === 0) {
		return { ok: false, value: normalized, reason: "blank" };
	}
	if (normalized.length > MAX_CASE_OPERATION_TEXT_LENGTH) {
		return { ok: false, value: normalized, reason: "too-long" };
	}
	return { ok: true, value: normalized };
}
