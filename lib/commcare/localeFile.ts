/** CommCare Core locale-file value rules, shared by validation and emission. */

import type { TranslationUnitRole } from "@/lib/domain";

const LOCALE_FILE_TRANSLATION_ROLES: ReadonlySet<TranslationUnitRole> = new Set(
	[
		"app-name",
		"module-name",
		"form-name",
		"case-list-menu-item-label",
		"case-list-registration-label",
		"case-list-header",
		"case-list-mapping-label",
		"case-list-interval-text",
		"search-input-label",
		"search-input-hint",
		"search-input-required-message",
		"search-input-validation-message",
		"search-screen-title",
		"search-screen-subtitle",
		"search-runtime-validation-message",
		"case-property-option-label",
	],
);

/** Whether this inventory role is serialized through a CommCare locale file. */
export function translationUnitUsesLocaleFile(
	role: TranslationUnitRole,
): boolean {
	return LOCALE_FILE_TRANSLATION_ROLES.has(role);
}

export function localeFileValueIssue(value: string): string | undefined {
	if (value.includes("\\n")) {
		return "contains the literal sequence \\n, which the locale-file grammar changes into a line break";
	}
	if (value.includes("\r")) {
		return "contains a carriage return, which the locale-file grammar cannot represent";
	}
	if (value.trim() === "") return undefined;
	const firstCodeUnit = value.charCodeAt(0);
	const lastCodeUnit = value.charCodeAt(value.length - 1);
	if (firstCodeUnit <= 0x20 || lastCodeUnit <= 0x20) {
		return "starts or ends with whitespace that the locale-file grammar discards";
	}
	return undefined;
}

/**
 * A text a project space holds in CommCare HQ, spelled as HQ's build writes
 * it into `app_strings.txt` (`commcare_translations.py::dumps`): a blank
 * text as one non-breaking space, each line break as `\n`, and each `#` no
 * backslash precedes as `\#`. HQ writes such a text whatever it holds, so an
 * archive that carries it takes the same spelling rather than refusing a
 * text Nova did not write.
 */
export function hqLocaleFileValue(value: string): string {
	if (isPythonBlank(value)) return "\u00a0";
	const lines = value.replaceAll("\n", "\\n");
	let spelled = "";
	for (let index = 0; index < lines.length; index += 1) {
		const unit = lines[index];
		spelled += unit === "#" && lines[index - 1] !== "\\" ? "\\#" : unit;
	}
	return spelled;
}

/**
 * The characters Python's `str.isspace()` holds, which is not the set
 * JavaScript's `trim` removes: U+0009 to U+000D, U+001C to U+001F, the space,
 * U+0085, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F
 * and U+3000.
 */
function isPythonSpace(code: number): boolean {
	return (
		(code >= 0x09 && code <= 0x0d) ||
		(code >= 0x1c && code <= 0x20) ||
		code === 0x85 ||
		code === 0xa0 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000
	);
}

/** A text Python's `str.strip()` leaves empty: every character of it is a space. */
function isPythonBlank(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (!isPythonSpace(value.charCodeAt(index))) return false;
	}
	return true;
}

/** Serialize a value exactly as Core's `LocalizationUtils` reads it. */
export function serializeLocaleFileValue(
	localeId: string,
	value: string,
): string {
	const issue = localeFileValueIssue(value);
	if (issue !== undefined) {
		throw new Error(`App string ${JSON.stringify(localeId)} ${issue}.`);
	}
	// HQ uses a non-breaking space to keep an intentionally blank locale id in
	// the table; Core discards a bare `key=` line entirely.
	if (value.trim() === "") return "\u00a0";
	return value.replaceAll("#", "\\#").replaceAll("\n", "\\n");
}
