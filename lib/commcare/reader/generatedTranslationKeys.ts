/**
 * A key of an app's `translations` that names a string CommCare HQ's build
 * generates (`appStringKeys.ts::GENERATED_APP_STRING_PATTERNS`), judged
 * against the app strings Nova's own build makes of the document as read:
 * what the key names, the same string's id where the document stands its
 * menus and forms at other positions, and whether the override changes
 * nothing, is the wording of one text Nova holds, or is anything else.
 */

import type { TranslationUnitId, WireStringSource } from "@/lib/domain";
import { generatedAppStringPattern } from "../appStringKeys";
import type { AppStringTable } from "./types";

/** What a generated key's id names. `menu` and `form` are positions, as the id spells them. */
export type GeneratedKeyOwner =
	| { readonly kind: "app" }
	| { readonly kind: "menu"; readonly menu: number }
	| { readonly kind: "form"; readonly menu: number; readonly form: number };

/** Where a key spells its menu's number, and its form's after it: the digits after `m`, and
 *  after `f`, at the place its pattern holds `m#`. */
interface NumberSpans {
	readonly menu: { readonly from: number; readonly to: number };
	readonly form?: { readonly from: number; readonly to: number };
}

function digitsFrom(key: string, from: number): number {
	let to = from;
	for (
		let digit = key[to];
		digit !== undefined && digit >= "0" && digit <= "9";
	)
		digit = key[++to];
	return to;
}

/**
 * The spans of the numbers a key's pattern names. Every pattern holds `m#` at most once, at its
 * start or straight after its first `.`, and what stands before that `.` is literal, so the key
 * spells it at the same place.
 */
function numberSpans(key: string): NumberSpans | undefined {
	const pattern = generatedAppStringPattern(key);
	if (pattern === undefined) return undefined;
	const dot = pattern.indexOf(".");
	const at = pattern.startsWith("m#")
		? 0
		: dot >= 0 && pattern.startsWith("m#", dot + 1)
			? dot + 1
			: -1;
	if (at < 0) return undefined;
	const keyAt = at === 0 ? 0 : key.indexOf(".") + 1;
	if (key[keyAt] !== "m") return undefined;
	const menuTo = digitsFrom(key, keyAt + 1);
	if (menuTo === keyAt + 1) return undefined;
	const menu = { from: keyAt + 1, to: menuTo };
	if (!pattern.slice(at).startsWith("m#f#")) return { menu };
	if (key[menuTo] !== "f") return undefined;
	const formTo = digitsFrom(key, menuTo + 1);
	if (formTo === menuTo + 1) return undefined;
	return { menu, form: { from: menuTo + 1, to: formTo } };
}

/** What `key` names: a form where its pattern holds `m#f#`, a menu where it holds `m#`, else the
 *  app. A key that matches no generated pattern names the app. */
export function generatedKeyOwner(key: string): GeneratedKeyOwner {
	const spans = numberSpans(key);
	if (spans === undefined) return { kind: "app" };
	const menu = Number(key.slice(spans.menu.from, spans.menu.to));
	if (spans.form === undefined) return { kind: "menu", menu };
	return {
		kind: "form",
		menu,
		form: Number(key.slice(spans.form.from, spans.form.to)),
	};
}

/** The key with its menu's and its form's numbers replaced: the same string as a document spells
 *  it whose menus and forms stand at other positions. A key that names no menu is its own. */
export function repositionGeneratedKey(
	key: string,
	to: { readonly menu: number; readonly form?: number },
): string {
	const spans = numberSpans(key);
	if (spans === undefined) return key;
	if (spans.form === undefined || to.form === undefined)
		return `${key.slice(0, spans.menu.from)}${to.menu}${key.slice(spans.menu.to)}`;
	return `${key.slice(0, spans.menu.from)}${to.menu}f${to.form}${key.slice(spans.form.to)}`;
}

export interface HeldGeneratedKey {
	readonly language: string;
	/** The key as `translations` holds it. */
	readonly key: string;
	/** The same string's id in the table (`repositionGeneratedKey`). */
	readonly id: string;
	readonly value: string;
}

export type GeneratedKeyVerdict =
	| { readonly kind: "inert" }
	| {
			readonly kind: "fold";
			readonly unit: TranslationUnitId;
			readonly language: string;
			readonly value: string;
	  }
	| {
			readonly kind: "wording";
			readonly unit: TranslationUnitId;
			readonly value: string;
	  }
	| { readonly kind: "not-yet" };

/**
 * What CommCare HQ's build of the app as it is stored reads under a held key that names a string
 * only a media map or an image map writes, which Nova's table of the document holds none of
 * (`appStrings.ts::localAppStringTable` builds it with no media manifest): `unread` where no
 * screen reads the key, `shows` with the path a language shows there without the override, and
 * `read` where a screen reads it and the app holds no text of its own under it. Undefined for
 * every other key, which the table judges.
 */
export type MediaKeyReading =
	| { readonly kind: "unread" }
	| { readonly kind: "shows"; readonly value: string }
	| { readonly kind: "read" };

/** The units a string's source names: one, several, or none for a constant. */
function unitsOf(
	source: WireStringSource | undefined,
): readonly TranslationUnitId[] {
	if (source === undefined) return [];
	return typeof source === "string" ? [source] : source;
}

/**
 * The verdict on each held key, in order, by the five rules: a blank value, an id no string of
 * the table has, and a value equal to the table's string are inert; an id whose source is one
 * translation unit, where every other id that unit feeds holds the same value in that language or
 * is this one, folds into that unit's text in that language; a split or constant with an owned output keeps its own wording. The
 * fold rule reads the stored value of every id a unit feeds, so `held` lists every generated key
 * whose menu and form read, those a finding covers among them.
 *
 * A key a media map or an image map writes (`media` answers for it) is judged by what HQ's build
 * reads there instead, since the table holds no such string: HQ's build writes a language's
 * override over the string it generates (`app_strings.py::SelectKnownAppStrings.app_strings_parts`,
 * the language's `translations` last), so where a screen reads the key the override is the file a
 * worker sees or hears, or the alt text a screen reader says, in that language. It is inert only
 * where no screen reads the key, or where it names the path the language shows without it; any
 * other override is a different file in one language. A registered image description is independently held on its mapping and screen.
 */
export function classifyGeneratedTranslationKeys(
	held: readonly HeldGeneratedKey[],
	table: AppStringTable,
	media: (one: HeldGeneratedKey) => MediaKeyReading | undefined = () =>
		undefined,
): readonly GeneratedKeyVerdict[] {
	const stored = new Map<string, string>();
	for (const one of held)
		stored.set(`${one.language}\u0000${one.id}`, one.value);
	const feeds = new Map<TranslationUnitId, string[]>();
	for (const [id, source] of Object.entries(table.units))
		for (const unit of unitsOf(source)) {
			const ids = feeds.get(unit) ?? [];
			ids.push(id);
			feeds.set(unit, ids);
		}
	return held.map((one): GeneratedKeyVerdict => {
		if (one.value === "") return { kind: "inert" };
		// HQ refers to this technical language code only in its mobile report
		// table (mobile_ucr.py), never on a screen of a document Nova admits.
		if (one.id === "lang.current") return { kind: "inert" };
		const wording =
			table.wordingUnits && Object.hasOwn(table.wordingUnits, one.id)
				? table.wordingUnits[one.id]
				: undefined;
		const own: GeneratedKeyVerdict = wording
			? { kind: "wording", unit: wording, value: one.value }
			: { kind: "not-yet" };
		const reading = media(one);
		if (one.id.split(".").at(-2) === "alt_text" && (wording || reading))
			return wording ? own : { kind: "inert" };
		if (reading !== undefined)
			return reading.kind === "unread" ||
				(reading.kind === "shows" && reading.value === one.value)
				? { kind: "inert" }
				: { kind: "not-yet" };
		const strings = table.languages[one.language];
		if (strings === undefined || !Object.hasOwn(strings, one.id))
			return { kind: "inert" };
		if (strings[one.id] === one.value) return { kind: "inert" };
		const source = Object.hasOwn(table.units, one.id)
			? table.units[one.id]
			: undefined;
		const units = unitsOf(source);
		const unit = units[0];
		if (units.length !== 1 || unit === undefined) return own;
		const agree = (feeds.get(unit) ?? []).every(
			(id) =>
				id === one.id || stored.get(`${one.language}\u0000${id}`) === one.value,
		);
		return agree
			? { kind: "fold", unit, language: one.language, value: one.value }
			: own;
	});
}
