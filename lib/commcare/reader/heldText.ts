/**
 * What a reading holds of a text CommCare HQ's build writes into the app
 * strings (a menu's or form's name, the app's name, a case list menu item's or
 * Register button's label, a column's header, an ID mapping's label, an
 * interval's text, a Search field's label, hint and messages, the search
 * screen's title and subtitle), given the text HQ's build shows in each
 * language (`hqText.ts::shownText`, or the search title's own rule): one
 * function for every such text, so no reader holds a text another way.
 *
 * What a worker reads is the bar (`hqDeviceText`). HQ's build writes each
 * text on one line of a locale file (`commcare_translations.py::dumps`): a
 * text Python reads as blank as one non-breaking space, which a device shows
 * as a blank text, and a line break as the two characters `\n`. CommCare
 * Core's locale reader trims each line (`LocalizationUtils.parseAndAdd`,
 * Java's `String.trim()`) and only then turns `\n` back into a line break
 * (`parseValue`), so the characters up to U+0020 at a text's end are gone,
 * but for a line break, and those at its start stay. Nova's gate admits no
 * text with a character up to U+0020 at either end
 * (`localeFile.ts::localeFileValueIssue`) and no blank translation of a text
 * whose role requires one (`translationUnits.ts`,
 * `contentPolicy: "require-nonblank"`), so a reading holds:
 *
 * - each language's text with the characters up to U+0020 at both ends
 *   dropped, unless it is only spaces, which Nova writes blank as HQ's build
 *   does (`holdText`);
 * - the source language's text in the slot, and each other language's as a
 *   translation where it differs, except a blank-looking one beside a source
 *   that is not, for a role that requires text: that language takes the
 *   source's text (`heldText`).
 *
 * Where that changes nothing a worker reads (`hqDeviceText` of what HQ showed
 * against `hqDeviceText` of what Nova prints, which HQ's build writes the same
 * way) the first publish only respells the stored map, under the surface's
 * respelling id; where it does (a blank-looking language that takes the
 * source's text, a space dropped at a text's start, a line break dropped at
 * either end) the reading records `text-spaces-dropped`
 * (`recordTextRewrite`). A text with a literal `\n`, a carriage return or a
 * character XML cannot hold has no spelling Nova's gate admits, and its reader
 * leaves it unclaimed.
 */

import {
	type TranslationUnitRole,
	translationRoleRequiresNonblank,
} from "@/lib/domain/translationUnits";
import {
	hqLocaleFileValue,
	isPythonSpace,
	localeFileValueIssue,
} from "../localeFile";
import { xmlTextIssue } from "../xmlText";
import type { ReadContext } from "./context";
import type { SameStateRegister } from "./types";

/** Whether Python's `str.strip()` leaves `text` empty: every character of it is a space. */
function pythonBlank(text: string): boolean {
	for (let index = 0; index < text.length; index += 1)
		if (!isPythonSpace(text.charCodeAt(index))) return false;
	return true;
}

/** Whether CommCare Core's locale reader drops the character at a line's end: Java's
 *  `String.trim()` removes every character up to U+0020. */
function trimmedByCore(text: string, index: number): boolean {
	return text.charCodeAt(index) <= 0x20;
}

/**
 * The text a device or Web Apps shows for an app string CommCare HQ's build
 * writes as `text`, `""` for one that shows blank. `commcare_translations.py::dumps`
 * writes a text Python reads as blank as one non-breaking space, a line break
 * as `\n` and a `#` no backslash precedes as `\#` (`localeFile.ts::hqLocaleFileValue`);
 * Core's `LocalizationUtils.parseAndAdd` reads the file a line at a time, a
 * carriage return ending one, trims the line, so the characters up to U+0020
 * at its end are gone, and then reads `\#` as `#` and `\n` as a line break
 * (`parseValue`). A line break at a text's end is therefore shown, and a
 * text's start keeps its spaces.
 */
export function hqDeviceText(text: string): string {
	if (pythonBlank(text)) return "";
	const line = hqLocaleFileValue(text).split("\r")[0] ?? "";
	let end = line.length;
	while (end > 0 && trimmedByCore(line, end - 1)) end -= 1;
	return line.slice(0, end).replaceAll("\\#", "#").replaceAll("\\n", "\n");
}

/** Whether a text is blank-looking: what the domain's content policy reads as blank. */
function blankLooking(text: string): boolean {
	return text.trim() === "";
}

/**
 * The text Nova holds for an app string a language shows as `text`, or
 * undefined where Nova's gate admits no spelling of it (a literal `\n` or a
 * carriage return, `localeFileValueIssue`, or a character XML cannot hold,
 * `xmlText.ts::xmlTextIssue`). A text that is only spaces is held as it is, a
 * carriage return in it as a space, since Nova writes it blank as HQ's build
 * does; any other loses the characters up to U+0020 at both ends: the spaces
 * at its end no device showed, and those at its start and a line break at
 * either end a device did (`hqDeviceText`).
 */
export function holdText(text: string): string | undefined {
	let held = text.replaceAll("\r", " ");
	if (!blankLooking(text)) {
		let start = 0;
		let end = text.length;
		while (start < end && trimmedByCore(text, start)) start += 1;
		while (end > start && trimmedByCore(text, end - 1)) end -= 1;
		held = text.slice(start, end);
	}
	return localeFileValueIssue(held) === undefined &&
		xmlTextIssue(held) === undefined
		? held
		: undefined;
}

/** What a reading holds of one text. */
export interface HeldText {
	/** The source language's text as Nova holds it: the slot's. */
	readonly source: string;
	/** By language code, each other language's text where Nova holds one that differs from the
	 *  source: the text's translations. */
	readonly translations: ReadonlyMap<string, string>;
	/** By language code, the text Nova prints in each language of `codes` that `shown` holds: its
	 *  translation where one stands, else the source's. */
	readonly printed: Readonly<Record<string, string>>;
	/** Whether a worker reads another text in some language after the first publish: a
	 *  blank-looking language that takes the source's text, a space dropped at a text's start,
	 *  or a line break dropped at either end. */
	readonly workersSeeAnother: boolean;
}

/**
 * What Nova holds of a text of role `role` that shows `shown` in each
 * language of `codes` (the build's languages, in order) with `source` the
 * source language's code, or undefined where Nova's gate admits no spelling of
 * one of those texts. A language `shown` lacks takes the source's text.
 */
export function heldText(
	shown: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
	codes: readonly string[],
	source: string,
	role: TranslationUnitRole,
): HeldText | undefined {
	const shownIn = (code: string): string | undefined =>
		shown instanceof Map
			? shown.get(code)
			: Object.hasOwn(shown, code)
				? (shown as Readonly<Record<string, string>>)[code]
				: undefined;
	const held = holdText(shownIn(source) ?? "");
	if (held === undefined) return undefined;
	const nonblank = translationRoleRequiresNonblank(role);
	const translations = new Map<string, string>();
	const printed: Record<string, string> = {};
	for (const code of codes) {
		const text = shownIn(code);
		if (text === undefined) continue;
		if (code === source) {
			printed[code] = held;
			continue;
		}
		const own = holdText(text);
		if (own === undefined) return undefined;
		// A blank-looking text is no translation where the role requires text (the language
		// takes the source's), nor beside a blank-looking source, which shows alike.
		const none = blankLooking(own) && (nonblank || blankLooking(held));
		if (!none && own !== held) translations.set(code, own);
		const translation = translations.get(code);
		// `translations.ts::translationEntryFor` makes no entry of an empty text beside a source
		// that holds one: Nova prints the source's there.
		printed[code] =
			translation === undefined || (translation === "" && held !== "")
				? held
				: translation;
	}
	const workersSeeAnother = codes.some((code) => {
		const text = shownIn(code);
		const print = printed[code];
		return (
			text !== undefined &&
			print !== undefined &&
			hqDeviceText(text) !== hqDeviceText(print)
		);
	});
	return { source: held, translations, printed, workersSeeAnother };
}

/** The ids a reading records a held text's rewrite under: a surface's respelling id, which no
 *  worker meets, and the one that touches workers. */
export type TextRespellingRegister = Extract<
	SameStateRegister,
	"names-respelled" | "list-settings-respelled"
>;

const TEXT_REGISTERS: ReadonlySet<SameStateRegister> = new Set([
	"names-respelled",
	"list-settings-respelled",
	"text-spaces-dropped",
]);

/**
 * Records that the first publish rewrites a held text's stored map at `at`:
 * under `text-spaces-dropped` where a worker then reads another text in some
 * language, else under `respelled`, the surface's respelling id. A map is
 * recorded once, the worker's change over the respelling.
 */
export function recordTextRewrite(
	ctx: ReadContext,
	at: { readonly entry: string; readonly path: string },
	respelled: TextRespellingRegister,
	workersSeeAnother: boolean,
): void {
	const register: SameStateRegister = workersSeeAnother
		? "text-spaces-dropped"
		: respelled;
	const rewrites = ctx.facts.sameStateRewrites;
	const index = rewrites.findIndex(
		(one) => one.path === at.path && TEXT_REGISTERS.has(one.register),
	);
	const known = index < 0 ? undefined : rewrites[index];
	if (known?.register === register || known?.register === "text-spaces-dropped")
		return;
	const record = { entry: at.entry, path: at.path, register };
	if (known === undefined) rewrites.push(record);
	else rewrites[index] = record;
}
