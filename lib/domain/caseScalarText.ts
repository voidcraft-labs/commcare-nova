/**
 * Shared value contract for CommCare case scalars stored in fixed-width text
 * columns (`case_name`, `external_id`, and operation-owned `owner_id`).
 *
 * CommCare Core applies Java `String.trim()` to case XML values: it removes
 * boundary UTF-16 code units from U+0000 through U+0020, not Java/JavaScript
 * regular-expression whitespace. Core then enforces a 255 Java UTF-16-unit
 * limit. Nova normalizes ordinary writes. An imported Survey can keep the
 * submitted case name for HQ while Preview persists the device case name after Core’s trim.
 */
export const MAX_CASE_SCALAR_TEXT_LENGTH = 255;

// biome-ignore lint/suspicious/noControlCharactersInRegex: exact Java String.trim U+0000..U+0020 contract.
const CASE_SCALAR_BOUNDARY_CODE_UNITS = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;

export type PreparedCaseScalarTextValue =
	| { readonly ok: true; readonly value: string }
	| {
			readonly ok: false;
			readonly value: string;
			readonly reason: "blank" | "too-long";
	  };

/** Normalize one evaluated scalar value exactly once before write. */
export function normalizeCaseScalarTextValue(value: string): string {
	return value.replace(CASE_SCALAR_BOUNDARY_CODE_UNITS, "");
}

/**
 * Validate a scalar result before any case write. A retained untrimmed
 * submission checks the original text, and device storage still normalizes it.
 *
 * Case names and operation-owned owners reject blank. `external_id` accepts an
 * explicit blank as a real `""` scalar write, distinct from no write.
 */
export function prepareCaseScalarTextValue(
	value: string,
	blank: "allow" | "reject",
	keepText = false,
): PreparedCaseScalarTextValue {
	const normalized = keepText ? value : normalizeCaseScalarTextValue(value);
	if (blank === "reject" && normalized.length === 0) {
		return { ok: false, value: normalized, reason: "blank" };
	}
	if (normalized.length > MAX_CASE_SCALAR_TEXT_LENGTH) {
		return { ok: false, value: normalized, reason: "too-long" };
	}
	return { ok: true, value: normalized };
}
