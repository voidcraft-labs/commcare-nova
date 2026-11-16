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
 * as a blank text, a line break as the two characters `\n`, which it also
 * writes for a text that holds those two characters, and a `#` no backslash
 * precedes as `\#`, leaving a `#` a backslash precedes as it is. CommCare
 * Core's locale reader ends a line at a carriage return
 * (`BufferedReader.readLine`), trims each line (`LocalizationUtils.parseAndAdd`,
 * Java's `String.trim()`) and only then reads `\#` as `#` and `\n` as a line
 * break (`parseValue`), so the characters up to U+0020 at a text's end are
 * gone, but for a line break, those at its start stay, the two characters `\n`
 * show as a line break, a backslash before `#` is not shown, and only the text
 * before a carriage return shows, each line after it read as an app string of
 * its own (`keyDefinedAfterLineEnd`). Nova's gate admits no text with a
 * character up to U+0020 at either end, a carriage return, or a backslash
 * followed by `n` or `#` (`localeFile.ts::localeFileValueIssue`) and no blank
 * translation of a text whose role requires one (`translationUnits.ts`,
 * `contentPolicy: "require-nonblank"`), so a reading holds:
 *
 * - each language's text as a device shows it: the text before a carriage
 *   return, each `\n` a line break, each `\#` a `#`, and the characters up to
 *   U+0020 at both ends dropped, unless it is only spaces, which Nova writes
 *   blank as HQ's build does (`holdText`);
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
 * (`recordTextRewrite`). A text whose rest after a carriage return defines
 * another app string is refused
 * (`application-and-settings/app-text-holding-a-carriage-return-whose-rest-defines-an-app-string`):
 * a held text where its rewrite is recorded (`refuseLineEndKey`), a text
 * compared with HQ's default and an app translation at its own key. A text
 * Nova's gate admits no spelling of (`unheldText`) is one finding at its place
 * (`refuseUnheldText`, `unheldRefusal`), and whatever holds it is still read:
 * a text a device shows none of, under the line-end entry where its rest
 * defines another app string and its own entry otherwise; a text a device
 * shows with a backslash before `#`; and a text of a role some screen reads
 * through Core's argument filler whose `${` that screen shows otherwise
 * (`localeFile.ts::argumentScreenIssue`: a menu's name shows as stored in Web
 * Apps' menu list and otherwise in the screen's title, and Nova holds one text
 * for both), each under its own entry; and a text holding, where a device
 * shows it, a character XML 1.0 cannot carry (`xmlText.ts::xmlTextIssue`),
 * which Nova's gate admits in no app text, under its own entry too.
 */

import {
	type TranslationUnitRole,
	translationRoleRequiresNonblank,
} from "@/lib/domain/translationUnits";
import type { HqPlace } from "@/lib/publish/hqFindings";
import {
	appStringValueIssue,
	hqLocaleFileValue,
	isPythonSpace,
	localeFileIssue,
} from "../localeFile";
import { xmlTextIssue } from "../xmlText";
import { type Claim, defineClaims, refuse } from "./claims";
import type { ReadContext } from "./context";
import { shownText } from "./hqText";
import { isJsonObject } from "./jsonCursor";
import { appPlace } from "./place";
import type { SameStateRegister } from "./types";

const CLAIMS = defineClaims("heldText", {
	/** A text whose rest after a carriage return HQ's build writes as a line that defines an
	 *  app string: a finding where the text's rewrite is recorded (`refuseLineEndKey`), and a
	 *  key's own claim where a reader refuses the key that holds such a text. */
	lineEndDefinesKey: refuse(
		"application-and-settings/app-text-holding-a-carriage-return-whose-rest-defines-an-app-string",
		null,
	),
	/** A text a device shows none of: nothing but spaces before a carriage return, whose rest
	 *  defines no app string (`refuseUnheldText`). */
	lineEndShowsNothing: refuse(
		"application-and-settings/app-text-holding-a-carriage-return-before-which-a-device-shows-nothing",
		null,
	),
	/** A text a device shows with a backslash right before `#` (`refuseUnheldText`). */
	backslashBeforeHash: refuse(
		"application-and-settings/app-text-a-device-shows-with-a-backslash-before-hash",
		null,
	),
	/** A text of a role some screen reads through Core's argument filler holding a `${` that
	 *  screen shows otherwise (`refuseUnheldText`). */
	placeholder: refuse(
		"application-and-settings/name-or-label-holding-a-placeholder-a-screen-fills",
		null,
	),
	/** A text holding, where a device shows it, a character XML 1.0 cannot carry, which Nova's
	 *  gate admits in no app text (`xmlText.ts::xmlTextIssue`, `refuseUnheldText`). */
	unrepresentableCharacter: refuse(
		"application-and-settings/app-text-holding-a-character-xml-cannot-carry",
		null,
	),
});

/** The claim of a text whose rest after a carriage return defines an app string, for a reader
 *  that refuses such a text at its own key. */
export const LINE_END_DEFINES_KEY = CLAIMS.lineEndDefinesKey;

/** Whether Python's `str.strip()` leaves `text` empty: every character of it is a space. */
export function pythonBlank(text: string): boolean {
	for (let index = 0; index < text.length; index += 1)
		if (!isPythonSpace(text.charCodeAt(index))) return false;
	return true;
}

/** Whether CommCare Core's locale reader drops the character at a line's end: Java's
 *  `String.trim()` removes every character up to U+0020. */
function trimmedByCore(text: string, index: number): boolean {
	return text.charCodeAt(index) <= 0x20;
}

/** Java's `String.trim()`: every character up to U+0020 at both ends dropped. */
function javaTrim(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && trimmedByCore(text, start)) start += 1;
	while (end > start && trimmedByCore(text, end - 1)) end -= 1;
	return text.slice(start, end);
}

/** Core's `LocalizationUtils.replace`: every occurrence, left to right, none overlapping. */
function coreReplace(text: string, pattern: string, by: string): string {
	return text.split(pattern).join(by);
}

/**
 * The app string one line of a locale file defines, as CommCare Core's
 * `LocalizationUtils.parseAndAdd` reads it: the line trimmed, a `#` no
 * backslash precedes and what follows it dropped, then the key before the
 * first `=` and the value after it, `\#` read as `#` and then `\n` as a line
 * break (`parseValue`). Undefined where the line defines nothing: no `=`, or
 * nothing after it.
 */
function coreLocaleLine(
	text: string,
): { readonly key: string; readonly value: string } | undefined {
	let line = javaTrim(text);
	let dec = line.length;
	for (;;) {
		const at = line.slice(0, dec).lastIndexOf("#");
		if (at === -1) break;
		if (at === 0 || line[at - 1] !== "\\") {
			line = line.slice(0, at);
			dec = line.length;
		} else dec = at;
	}
	const equal = line.indexOf("=");
	if (equal === -1 || equal === line.length - 1) return undefined;
	return {
		key: line.slice(0, equal),
		value: coreReplace(
			coreReplace(line.slice(equal + 1), "\\#", "#"),
			"\\n",
			"\n",
		),
	};
}

/** The lines Core reads of the one line HQ's build writes for `text` under a key: `dumps`'
 *  spelling of it, split where `BufferedReader.readLine` ends a line. */
function writtenLines(text: string): readonly string[] {
	return hqLocaleFileValue(text).split("\r");
}

/** The key a text's line is written under here: one with no `=`, `#` or space, since only the
 *  value's place in the line matters to what Core reads of it. */
const SOME_KEY = "k";

/**
 * The text a device or Web Apps shows for an app string CommCare HQ's build
 * writes as `text`, `""` for one that shows blank. `commcare_translations.py::dumps`
 * writes a text Python reads as blank as one non-breaking space, a line break
 * as `\n` and a `#` no backslash precedes as `\#` (`localeFile.ts::hqLocaleFileValue`);
 * Core reads the line HQ writes up to a carriage return, trims it, so the
 * characters up to U+0020 at its end are gone, and then reads `\#` as `#` and
 * `\n` as a line break (`coreLocaleLine`). A line break at a text's end is
 * therefore shown, and a text's start keeps its spaces. Where the line holds
 * nothing after its key, the language's file defines no string, which this
 * gives as `""` and `holdText` holds no spelling of.
 */
export function hqDeviceText(text: string): string {
	if (pythonBlank(text)) return "";
	const first = writtenLines(text)[0] ?? "";
	return coreLocaleLine(`${SOME_KEY}=${first}`)?.value ?? "";
}

/**
 * The app string the rest of `text` defines in the locale file HQ's build
 * writes it into, or undefined where it defines none: HQ's build leaves a
 * carriage return as it is (`dumps`), Core ends a line there, and reads each
 * line after it as a line of its own (`coreLocaleLine`), so a rest that holds
 * `=` with text after it sets the string its key names. A rest whose key is
 * empty sets no string a runtime asks for, and is none.
 */
export function keyDefinedAfterLineEnd(text: string): string | undefined {
	if (pythonBlank(text)) return undefined;
	for (const line of writtenLines(text).slice(1)) {
		const defined = coreLocaleLine(line);
		if (defined !== undefined && defined.key !== "") return defined.key;
	}
	return undefined;
}

/** Whether a text is blank-looking: what the domain's content policy reads as blank. */
function blankLooking(text: string): boolean {
	return text.trim() === "";
}

/**
 * Why Nova's gate admits no spelling of a text a language shows: a device
 * shows none of it (the line HQ's build writes holds nothing after its key
 * before a carriage return, so the language defines no string), a device shows
 * a backslash right before `#` in it (two backslashes then `#` stored), a
 * screen of its role fills a placeholder in it (`localeFile.ts::argumentScreenIssue`),
 * or it holds a character XML cannot hold (`xmlText.ts::xmlTextIssue`).
 */
export type UnheldCause =
	| "nothing-before-carriage-return"
	| "backslash-before-hash"
	| "placeholder"
	| "unrepresentable-character";

/** A text of a stored map Nova's gate admits no spelling of, and why. */
export interface UnheldText {
	readonly cause: UnheldCause;
	/** The text as the language shows it in HQ's build, as it is stored. */
	readonly text: string;
}

/**
 * The text Nova holds for an app string a language shows as `text`, or why
 * Nova's gate admits no spelling of it. A text that is only spaces is held as
 * it is, a carriage return in it as a space, since Nova writes it blank as
 * HQ's build does. Any other is held as a device shows it (`hqDeviceText`):
 * the text before a carriage return, each `\#` the `#` and then each two
 * characters `\n` the line break Core reads them as (left to right, as
 * `parseValue` reads them: `dumps` writes a line break as those two characters
 * and leaves a `#` a backslash precedes, so HQ's build writes the same line for
 * either), and the characters up to U+0020 dropped at both ends: the spaces at
 * its end no device showed, and those at its start and a line break at either
 * end a device did. Nova prints the held text to the line HQ's build writes
 * for it, which a device shows as the same text. What a device shows never
 * holds the two characters `\n` (Core reads each as a line break, which no
 * replacement makes again), a carriage return or a space at either end, so of
 * what the gate refuses only a backslash before `#` remains, which two
 * backslashes then `#` stored spell. What the rest after a carriage return
 * defines is `keyDefinedAfterLineEnd`'s to say.
 */
function holdOrCause(
	text: string,
):
	| { readonly held: string }
	| { readonly cause: Exclude<UnheldCause, "placeholder"> } {
	let held = text.replaceAll("\r", " ");
	if (!blankLooking(text)) {
		if (pythonBlank(text)) held = javaTrim(text.split("\r")[0] ?? "");
		else {
			const shown = coreLocaleLine(
				`${SOME_KEY}=${writtenLines(text)[0] ?? ""}`,
			);
			// Nothing but characters up to U+0020 before the line's end: a carriage return, or a
			// control character XML cannot hold, which is what the text's own line then holds.
			if (shown === undefined)
				return {
					cause:
						xmlTextIssue(text.split("\r")[0] ?? "") === undefined &&
						text.includes("\r")
							? "nothing-before-carriage-return"
							: "unrepresentable-character",
				};
			held = javaTrim(shown.value);
		}
	}
	if (xmlTextIssue(held) !== undefined)
		return { cause: "unrepresentable-character" };
	const issue = localeFileIssue(held);
	switch (issue) {
		case undefined:
			return { held };
		case "backslash-hash":
			return { cause: "backslash-before-hash" };
		case "backslash-n":
		case "carriage-return":
		case "edge-space":
			// What a device shows holds none of these (above), so a held text that does is the
			// reader's own reading gone wrong, never a cause to report of the app.
			throw new Error(
				`A text held as a device shows it still holds what the locale file shows otherwise (${issue}). holdOrCause in lib/commcare/reader/heldText.ts reads a device's text without the two characters \\n, a carriage return or a space at either end, so its reading of the stored text has gone wrong.`,
			);
	}
}

/**
 * The text Nova holds for an app string a language shows as `text`, or
 * undefined where Nova's gate admits no spelling of it (`holdOrCause`).
 */
export function holdText(text: string): string | undefined {
	const one = holdOrCause(text);
	return "held" in one ? one.held : undefined;
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
 * one of those texts: `holdText` gives none, or what it gives is refused for
 * the role (`localeFile.ts::appStringValueIssue`, a `${` some screen of the
 * role shows otherwise). A language `shown` lacks takes the source's text.
 */
export function heldText(
	shown: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
	codes: readonly string[],
	source: string,
	role: TranslationUnitRole,
): HeldText | undefined {
	const read = readHeldText(shown, codes, source, role);
	return "cause" in read ? undefined : read;
}

/**
 * What Nova's gate admits no spelling of among the texts `heldText` reads, the
 * first in the order it reads them (the source language's, then each other
 * language's in `codes` order), or undefined where it holds every one.
 */
export function unheldText(
	shown: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
	codes: readonly string[],
	source: string,
	role: TranslationUnitRole,
): UnheldText | undefined {
	const read = readHeldText(shown, codes, source, role);
	return "cause" in read ? read : undefined;
}

/** `heldText`'s reading, with the first text it holds no spelling of and why where it holds none. */
function readHeldText(
	shown: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
	codes: readonly string[],
	source: string,
	role: TranslationUnitRole,
): HeldText | UnheldText {
	const shownIn = (code: string): string | undefined =>
		shown instanceof Map
			? shown.get(code)
			: Object.hasOwn(shown, code)
				? (shown as Readonly<Record<string, string>>)[code]
				: undefined;
	const holdAs = (text: string): string | UnheldText => {
		const one = holdOrCause(text);
		if ("cause" in one) return { cause: one.cause, text };
		return appStringValueIssue(one.held, role) === undefined
			? one.held
			: { cause: "placeholder", text };
	};
	const held = holdAs(shownIn(source) ?? "");
	if (typeof held !== "string") return held;
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
		const own = holdAs(text);
		if (typeof own !== "string") return own;
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

/** The value of the source app at a JSON pointer, undefined where none stands there. */
function sourceValueAt(ctx: ReadContext, path: string): unknown {
	let node: unknown = ctx.input.source.raw;
	for (const token of path.split("/").slice(1)) {
		const step = token.replaceAll("~1", "/").replaceAll("~0", "~");
		if (Array.isArray(node)) node = node[Number(step)];
		else if (isJsonObject(node) && Object.hasOwn(node, step)) node = node[step];
		else return undefined;
	}
	return node;
}

/** The build's languages: the source's `langs`, as HQ's build writes a file for each. */
function buildLanguages(ctx: ReadContext): readonly string[] {
	const raw = ctx.input.source.raw;
	const langs = isJsonObject(raw) ? raw.langs : undefined;
	return Array.isArray(langs)
		? langs.filter((one): one is string => typeof one === "string")
		: [];
}

/**
 * Where a finding about the app string stored at `path` stands: a form's text at the form, a
 * case list's, case detail's or search's at that part of its menu, a menu's at the menu, and
 * the app's name and its translations at the app.
 */
function textPlace(ctx: ReadContext, path: string): HqPlace {
	const steps = path.split("/").slice(1);
	if (steps[0] !== "modules") return appPlace();
	const module = ctx.draft.modules.find(
		(one) => one.index === Number(steps[1]),
	);
	if (module === undefined) return appPlace();
	if (steps[2] === "forms")
		return (
			module.forms.find((one) => one.index === Number(steps[3]))?.place ??
			module.place
		);
	const part =
		steps[2] === "search_config"
			? "search"
			: steps[2] === "case_details" && steps[3] === "long"
				? "case-detail"
				: steps[2] === "case_details" ||
						steps[2] === "case_list" ||
						steps[2] === "case_list_form"
					? "case-list"
					: undefined;
	if (part === undefined || module.place.kind !== "menu") return module.place;
	return { kind: part, menu: module.index, name: module.place.name };
}

const LINE_END_REFUSED = new WeakMap<ReadContext, Set<string>>();

/**
 * Refuses the app string stored at `path` where a text HQ's build writes of it, in some build
 * language (`hqText.ts::shownText` over a `{lang: text}` map, the value itself for a string),
 * holds a rest after a carriage return that defines another app string
 * (`keyDefinedAfterLineEnd`): the reading holds what devices show of the text, and the rest
 * would set the wording of the string it names, which no document holds. Once per path.
 * `recordTextRewrite` calls it; a site that holds a text whose rewrite another register records
 * (a Register label's `registration-label-fixed`) calls it itself.
 */
export function refuseLineEndKey(ctx: ReadContext, path: string): void {
	const refused = LINE_END_REFUSED.get(ctx) ?? new Set<string>();
	LINE_END_REFUSED.set(ctx, refused);
	if (refused.has(path)) return;
	const key = storedKeyDefinedAfterLineEnd(
		sourceValueAt(ctx, path),
		buildLanguages(ctx),
	);
	if (key === undefined) return;
	refused.add(path);
	ctx.accounting.finding(CLAIMS.lineEndDefinesKey, textPlace(ctx, path), {
		name: key,
	});
}

/** The claim each cause of an unheld text is refused under. */
const UNHELD_CLAIMS: Readonly<Record<UnheldCause, Claim<"refuse">>> = {
	"nothing-before-carriage-return": CLAIMS.lineEndShowsNothing,
	"backslash-before-hash": CLAIMS.backslashBeforeHash,
	placeholder: CLAIMS.placeholder,
	"unrepresentable-character": CLAIMS.unrepresentableCharacter,
};

/**
 * The one finding at `place` for an app string Nova's gate admits no spelling
 * of (`unheldText`), stored under the surface key `key`: a text a device shows
 * none of before a carriage return is refused under the line-end entry where
 * its rest defines another app string (`keyDefinedAfterLineEnd`, naming that
 * string's key) and under its own entry otherwise; a text a device shows with
 * a backslash before `#`, one holding a `${` a screen of its role fills, and
 * one holding a character XML 1.0 cannot carry, each under its own entry,
 * naming the text as the language shows it. A map whose text the reader cannot
 * know (`unheld` undefined) is `unrecognized` under `key`. A caller that gives
 * this finding reads the rest of what holds the text, so the one text is one
 * finding.
 */
export function refuseUnheldText(
	ctx: ReadContext,
	place: HqPlace,
	key: string,
	unheld: UnheldText | undefined,
): void {
	const refusal = unheldRefusal(unheld);
	if (refusal === undefined)
		ctx.accounting.circumstance("unrecognized", place, { name: key });
	else ctx.accounting.finding(refusal.claim, place, { name: refusal.name });
}

/**
 * The claim an unheld text is refused under and the name its finding gives
 * (`refuseUnheldText`), or undefined where the reader cannot know the text
 * (`unheld` undefined), which is `unrecognized`: for a site that refuses the
 * key holding the text, which the close then leaves.
 */
export function unheldRefusal(
	unheld: UnheldText | undefined,
): { readonly claim: Claim<"refuse">; readonly name: string } | undefined {
	if (unheld === undefined) return undefined;
	const defined =
		unheld.cause === "nothing-before-carriage-return"
			? keyDefinedAfterLineEnd(unheld.text)
			: undefined;
	return defined !== undefined
		? { claim: CLAIMS.lineEndDefinesKey, name: defined }
		: { claim: UNHELD_CLAIMS[unheld.cause], name: unheld.text };
}

/**
 * The app string the rest of a stored text defines after a carriage return
 * (`keyDefinedAfterLineEnd`) in some language of `langs` HQ's build writes it
 * in: a `{lang: text}` map as each language shows it (`hqText.ts::shownText`),
 * a string as it stands. Undefined where none does.
 */
export function storedKeyDefinedAfterLineEnd(
	stored: unknown,
	langs: readonly string[],
): string | undefined {
	const texts: string[] = [];
	if (typeof stored === "string") texts.push(stored);
	else if (isJsonObject(stored))
		for (const code of langs) {
			const shown = shownText(stored, code, langs);
			if (shown.ok) texts.push(shown.text);
		}
	for (const text of texts) {
		const key = keyDefinedAfterLineEnd(text);
		if (key !== undefined) return key;
	}
	return undefined;
}

/**
 * Whether a device shows `text` in every language of `codes` for a stored
 * `{lang: text}` app string (`hqText.ts::shownText`, then `hqDeviceText`):
 * HQ's default, however the map spells it, where `text` is the default's.
 * Undefined where the build prints a value the reader cannot know.
 */
export function showsInEveryLanguage(
	stored: unknown,
	codes: readonly string[],
	text: string,
): boolean | undefined {
	let every = true;
	for (const code of codes) {
		const shown = shownText(stored, code, codes);
		if (!shown.ok) return undefined;
		if (hqDeviceText(shown.text) !== text) every = false;
	}
	return every;
}

/**
 * Records that the first publish rewrites a held text's stored map at `at`:
 * under `text-spaces-dropped` where a worker then reads another text in some
 * language, else under `respelled`, the surface's respelling id. A map is
 * recorded once, the worker's change over the respelling. A held text with a
 * carriage return is always rewritten, since Nova prints none, so a site
 * records it here, or under another register where it calls
 * `refuseLineEndKey` itself, and this is where such a text is refused if its
 * rest defines another app string.
 */
export function recordTextRewrite(
	ctx: ReadContext,
	at: { readonly entry: string; readonly path: string },
	respelled: TextRespellingRegister,
	workersSeeAnother: boolean,
): void {
	refuseLineEndKey(ctx, at.path);
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
