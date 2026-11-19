/**
 * CommCare's locale-file values: the gate's rule for a text that lands in the
 * app strings, and the one writer of such a value.
 *
 * A text reaches a device through two writers. CommCare HQ's build writes it
 * on one line of `app_strings.txt` (`commcare_translations.py::dumps`, at the
 * pin of HQ's `submodules/commcare-translations`), and Nova's local archive
 * writes the same bytes (`hqLocaleFileValue`). CommCare Core then reads the
 * line (`LocalizationUtils.parseLocaleInput`): `BufferedReader.readLine` ends
 * it at a carriage return, `parseAndAdd` trims it with Java's `String.trim()`
 * and drops a `#` no backslash precedes and what follows it, and `parseValue`
 * reads `\#` as `#` and then `\n` as a line break, every occurrence left to
 * right. Nothing else in the locale file consumes a character.
 *
 * So the sequences an author can type that a device shows as something else
 * in every text the locale file holds, after both writers, are exactly these,
 * each refused by `localeFileValueIssue`:
 *
 * - a backslash followed by `n`: `dumps` leaves it, and Core reads it as a
 *   line break;
 * - a backslash followed by `#`: `dumps` leaves the `#` unescaped, since a
 *   backslash precedes it, and Core reads `\#` as `#`, dropping the backslash
 *   (two backslashes then `#` show as one backslash then `#`);
 * - a carriage return: Core ends the line there, and reads the rest as a line
 *   of its own;
 * - a character up to U+0020 at the text's end, which Core's trim drops, and,
 *   so that a text shows alike in the builder and on a device, at its start.
 *
 * Every other character shows as typed: a line break (`dumps` writes `\n`,
 * Core reads it back), a `#` no backslash precedes (`dumps` writes `\#`), a
 * backslash before any other character or at the text's end, two backslashes
 * not followed by `n` or `#`, an `=`. A text Python reads as blank is written
 * as one non-breaking space, which a device shows as a blank text.
 *
 * Some screens then read the text once more (`argumentScreenIssue`): the
 * places a worker meets a menu's or form's name, a case list menu item's or
 * Register button's label and a Search field's label pass it through Core's
 * `Localizer.processArguments(text, new String[]{""})` and trim the result
 * (commcare-android `MenuAdapter.setupTextView`, `ViewUtil.addActionToMenu`
 * through `Localizer.clearArguments`, `QueryRequestUiController.getLabel`, and
 * Core's `CommCareSession.getHeaderTitles`, which both Android's and Web Apps'
 * screen titles and breadcrumbs read through `ScreenUtils.getBestTitle`), so
 * a `${` there shows otherwise: `Visits ${0}` as `Visits`, and `a${b`, whose
 * `${` no `}` follows, as `aa${b`. Web Apps' menu list shows the same name as
 * stored, so no text Nova could hold shows alike on every screen.
 *
 * A form's itext is no app string: Core reads an itext value as the XML text
 * it is (`XFormParser.parseTextHandle`, `getLabel`) and unescapes nothing.
 */

import type { TranslationUnitRole } from "@/lib/domain";

const LOCALE_FILE_TRANSLATION_ROLES: ReadonlySet<TranslationUnitRole> = new Set(
	[
		"app-name",
		"module-name",
		"form-name",
		"case-list-menu-item-label",
		"case-list-registration-label",
		"case-list-header",
		"case-list-sort-label",
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

/**
 * The roles whose text some screen reads through Core's argument filler
 * (`argumentScreenIssue`): a menu's and a form's name, the case list menu
 * item's and the Register button's label, and a Search field's label.
 */
const ARGUMENT_SCREEN_ROLES: ReadonlySet<TranslationUnitRole> = new Set([
	"module-name",
	"form-name",
	"case-list-menu-item-label",
	"case-list-registration-label",
	"search-input-label",
]);

/**
 * What makes a device show an app string other than as typed: a backslash
 * followed by `n`, a backslash followed by `#`, a carriage return, a space or
 * line break at either end (`localeFileValueIssue`), or, in a role some screen
 * reads through Core's argument filler, a `${` that filler changes
 * (`argumentScreenIssue`).
 */
export type AppStringIssue =
	| "backslash-n"
	| "backslash-hash"
	| "carriage-return"
	| "edge-space"
	| "placeholder";

const APP_STRING_ISSUE_SENTENCES: Readonly<Record<AppStringIssue, string>> = {
	"backslash-n":
		"contains a backslash followed by n, which a device shows as a line break",
	"backslash-hash":
		"contains a backslash followed by #, which a device shows as # alone",
	"carriage-return":
		"contains a carriage return, which ends the text on a device",
	"edge-space":
		"starts or ends with a space or a line break, which a device drops",
	placeholder:
		"contains ${, which CommCare reads as a placeholder in menus, screen titles and Search fields, so a device shows other text there",
};

/** An issue as the end of a sentence about the text. */
export function appStringIssueSentence(issue: AppStringIssue): string {
	return APP_STRING_ISSUE_SENTENCES[issue];
}

/**
 * What would make a device show an app string of role `role` other than as
 * `value` holds it, or undefined where every screen shows it as typed: what
 * the locale file does to it (`localeFileIssue`), and, for a role some screen
 * reads through Core's argument filler, what that does (`argumentScreenIssue`).
 */
export function appStringIssue(
	value: string,
	role: TranslationUnitRole,
): AppStringIssue | undefined {
	return (
		localeFileIssue(value) ??
		(ARGUMENT_SCREEN_ROLES.has(role) && argumentScreenIssue(value) !== undefined
			? "placeholder"
			: undefined)
	);
}

/**
 * Why a device would show an app string of role `role` other than as `value`
 * holds it, as the end of a sentence about the text, or undefined where every
 * screen shows it as typed (`appStringIssue`). The gate's rule for every app
 * string an author or a translation holds.
 */
export function appStringValueIssue(
	value: string,
	role: TranslationUnitRole,
): string | undefined {
	const issue = appStringIssue(value, role);
	return issue === undefined ? undefined : APP_STRING_ISSUE_SENTENCES[issue];
}

/**
 * Why a screen that reads a text through Core's argument filler would show
 * `value` otherwise, or undefined where it shows it as typed.
 * `Localizer.processArguments(text, new String[]{""})` acts only where the
 * text holds `${`: it replaces the first `${…}` with the empty argument, and
 * where no `}` follows that `${`, it writes the text before it and then the
 * whole text again (`replaceFirstValue` takes the rest from index `-1 + 1`).
 * So the text changes unless its first `${` opens it and no `}` follows,
 * where the text before it is empty and the whole text follows unchanged.
 * `clearArguments` changes a text only where some `${` has a `}` after it,
 * which `processArguments` changes too, and the trim after either finds no
 * space at the ends of a text the locale rule admits.
 */
export function argumentScreenIssue(value: string): string | undefined {
	const first = value.indexOf("${");
	if (first === -1) return undefined;
	if (first === 0 && value.indexOf("}", first) === -1) return undefined;
	return APP_STRING_ISSUE_SENTENCES.placeholder;
}

/** What the locale file does to `value` that a device shows otherwise, or undefined where it
 *  shows it as typed (`localeFileValueIssue`). */
export function localeFileIssue(
	value: string,
): Exclude<AppStringIssue, "placeholder"> | undefined {
	if (value.includes("\\n")) return "backslash-n";
	if (value.includes("\\#")) return "backslash-hash";
	if (value.includes("\r")) return "carriage-return";
	if (value.trim() === "") return undefined;
	const firstCodeUnit = value.charCodeAt(0);
	const lastCodeUnit = value.charCodeAt(value.length - 1);
	if (firstCodeUnit <= 0x20 || lastCodeUnit <= 0x20) return "edge-space";
	return undefined;
}

/**
 * Why a device would show any app string other than as `value` holds it, as
 * the end of a sentence about the text, or undefined where it shows as typed:
 * what the locale file does to every text it holds. A text of an authored
 * role is held to `appStringValueIssue`, which adds what some screens do.
 */
export function localeFileValueIssue(value: string): string | undefined {
	const issue = localeFileIssue(value);
	return issue === undefined ? undefined : APP_STRING_ISSUE_SENTENCES[issue];
}

/**
 * A text spelled as CommCare HQ's build writes it into `app_strings.txt`
 * (`commcare_translations.py::dumps`): a text Python reads as blank as one
 * non-breaking space, which keeps the key in the table where Core drops a
 * bare `key=` line, each line break as `\n`, and each `#` no backslash
 * precedes, after that step, as `\#`. It is total: Nova's local archive
 * writes every app string through it, Nova's own text (which the gate holds
 * to `localeFileValueIssue`, so a device shows it as typed) and the text a
 * project space holds under its own keys alike, so a worker reads one string
 * from Nova's archive and from HQ's build.
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
export function isPythonSpace(code: number): boolean {
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
