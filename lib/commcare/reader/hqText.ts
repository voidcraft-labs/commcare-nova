/**
 * The one reading of a CommCare HQ `{language: text}` map (a module's or a
 * form's `name`, a column `header`, a case list `label`, a search
 * `description` ...) as CommCare HQ's build shows it.
 *
 * HQ picks a language's text with one function, `_trans` in
 * `corehq/apps/app_manager/templatetags/xforms_extras.py`, which every
 * variant below wraps:
 *
 * - `clean_trans(name, langs)` (`include_lang=False`) is the text an app
 *   string holds. `app_strings.py::_create_custom_app_strings` calls it with
 *   `[lang] + ccz_langs` for every text of the suite (module and form names,
 *   column headers, case list labels, search labels and hints, custom
 *   assertions); `Module.default_name` and `Form.default_name` call it with
 *   `[app.default_language] + app.langs`. `cleanTrans` here.
 * - `trans(name, langs)` (`include_lang=True`, `use_delim=True`) is the same
 *   choice with a ` [lang] ` marker after a text taken from any language but
 *   `langs[0]`. The build calls it only for the descriptor of a form's suite
 *   resource (`suite_xml/sections/resources.py`, `langs=[default_lang]`) and
 *   the due-list name of the scheduler (`suite_xml/features/scheduler.py`);
 *   no device shows either. `markedTrans` here.
 * - `translate(t, lang, langs)` (the form designer's view) takes any present
 *   key, `None` included, and is not the build's: nothing here mirrors it.
 *
 * What a device or Web Apps shows for one language is a composition of
 * `clean_trans` with the build's locale files, `shownText` here: the
 * language's own `app_strings.txt` drops an empty string
 * (`AppStringsBase.create_custom_app_strings`, `non_empty_only`), and
 * CommCare's `Localizer.getText` falls back to the `default` locale, which
 * `AppStringsBase.create_default_app_strings` builds from every build
 * language in reverse order, a blank never overwriting a text.
 *
 * Every function is total: a map that is no JSON object, or a value whose
 * Python `str()` the reader cannot know from the parsed JSON (a number, since
 * `5` and `5.0` parse alike and print differently; an object; an array) gives
 * `{ ok: false }` naming the language it was taken from, never a throw and
 * never a guess. `null` prints `None` and a boolean `True` or `False`, as
 * Python's `str()` does, where HQ's choice reaches one.
 */

import { recordFromEntries } from "@/lib/domain/records";
import { defaultTableText } from "../appStringKeys";
import { chargeWork } from "../workMeter";

/** A text HQ's build shows, or why the reader cannot know it. */
export type HqText =
	| { readonly ok: true; readonly text: string }
	| {
			readonly ok: false;
			/** `not-a-map` where the stored value is no `{language: text}` object; `value` where the
			 *  chosen language holds a value whose printed text the reader cannot know. */
			readonly reason: "not-a-map" | "value";
			/** The language the unreadable value was taken from, for `reason: "value"`. */
			readonly lang?: string;
	  };

/** The source text and its translations of one stored map, or why the reader cannot know them. */
export type HqSourceAndTranslations =
	| {
			readonly ok: true;
			readonly source: string;
			readonly translations: Readonly<Record<string, string>>;
	  }
	| Extract<HqText, { ok: false }>;

/** HQ's build never makes a locale file named `default` from `app.langs`
 *  (`create_default_app_strings` skips it). */
const DEFAULT_LOCALE = "default";

type TextMap = Readonly<Record<string, unknown>>;

function asTextMap(stored: unknown): TextMap | undefined {
	if (stored === null || typeof stored !== "object" || Array.isArray(stored))
		return undefined;
	return stored as TextMap;
}

/** Python's `str(value)` for a JSON value, where the parsed value fixes it. */
function pythonStr(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value === null) return "None";
	if (typeof value === "boolean") return value ? "True" : "False";
	return undefined;
}

/** Python's `str` ordering: by code point, not by UTF-16 unit. */
export function compareCodePoints(a: string, b: string): number {
	const left = [...a];
	const right = [...b];
	for (let i = 0; i < Math.min(left.length, right.length); i++) {
		const x = left[i].codePointAt(0) ?? 0;
		const y = right[i].codePointAt(0) ?? 0;
		if (x !== y) return x - y;
	}
	return left.length - right.length;
}

/** `_trans`'s choice: the language whose value HQ prints, or none for an empty map. */
function chooseLanguage(
	map: TextMap,
	langs: readonly string[],
): { readonly lang: string; readonly requested: boolean } | undefined {
	for (const lang of langs) {
		// `lang in name and name[lang] is not None`: a blank string is present.
		if (Object.hasOwn(map, lang) && map[lang] !== null)
			return { lang, requested: true };
	}
	// `sorted(name.items())[0]`: the least key, whatever its value, `None` included.
	const keys = Object.keys(map).sort(compareCodePoints);
	return keys.length === 0 ? undefined : { lang: keys[0], requested: false };
}

function langsOrDefault(langs: readonly string[]): readonly string[] {
	// `langs = langs or ["default"]`
	return langs.length === 0 ? [DEFAULT_LOCALE] : langs;
}

function printed(map: TextMap, lang: string, affix: string): HqText {
	const text = pythonStr(map[lang]);
	return text === undefined
		? { ok: false, reason: "value", lang }
		: { ok: true, text: text + affix };
}

/**
 * HQ's `clean_trans(name, langs)` (`xforms_extras.py`, `_trans` with
 * `include_lang=False`): the value of the first of `langs` the map holds and
 * that is not `None` (a blank string counts as held), else the value of the
 * map's least key, else `""` for an empty map. An empty `langs` is
 * `["default"]`, as in HQ.
 */
export function cleanTrans(stored: unknown, langs: readonly string[]): HqText {
	const map = asTextMap(stored);
	if (map === undefined) return { ok: false, reason: "not-a-map" };
	const chosen = chooseLanguage(map, langsOrDefault(langs));
	return chosen === undefined
		? { ok: true, text: "" }
		: printed(map, chosen.lang, "");
}

/**
 * HQ's `trans(name, langs)` (`xforms_extras.py`, `_trans` with the bracket
 * marker): `cleanTrans`'s text, followed by ` [lang] ` when it was taken from
 * any language but the first of `langs`, or from the map's least key. The
 * build calls it for a form resource's `descriptor`
 * (`suite_xml/sections/resources.py`) and the scheduler's due-list name.
 */
export function markedTrans(stored: unknown, langs: readonly string[]): HqText {
	const map = asTextMap(stored);
	if (map === undefined) return { ok: false, reason: "not-a-map" };
	const requested = langsOrDefault(langs);
	const chosen = chooseLanguage(map, requested);
	if (chosen === undefined) return { ok: true, text: "" };
	const first = chosen.requested && chosen.lang === requested[0];
	return printed(map, chosen.lang, first ? "" : ` [${chosen.lang}] `);
}

/**
 * The text a device or Web Apps shows for an app string in language `lang`,
 * given the build's languages `langs` in order (`app.langs`, or a build
 * profile's). The language's own file holds `clean_trans(name, [lang] +
 * langs)` unless that is blank (`_create_custom_app_strings`,
 * `create_custom_app_strings`'s `non_empty_only`); a blank falls back
 * (`Localizer.getText`) to the `default` locale, which
 * `create_default_app_strings` fills from `clean_trans(name, [lc] + langs)`
 * for each `lc` of `langs` in reverse, a blank never replacing a text: the
 * first build language whose text is not blank, else `""`. The merge reads
 * each language's table back through `commcare_translations.loads`, which
 * strips each line `dumps` wrote: a text Python reads as blank (only spaces,
 * which `dumps` writes as one non-breaking space) is `""` there and never
 * replaces a text, and every other loses the spaces at its end
 * (`appStringKeys.ts::defaultTableText`, the emitter's reading of the same
 * merge).
 */
export function shownText(
	stored: unknown,
	lang: string,
	langs: readonly string[],
): HqText {
	const map = asTextMap(stored);
	if (map === undefined) return { ok: false, reason: "not-a-map" };
	return mapShower(map, langs).shown(lang);
}

/** What one stored map shows in each language of one build's languages. */
interface MapShower {
	shown(lang: string): HqText;
}

/** Each map's shower, by the map and the languages it was made for. */
const showers = new WeakMap<object, WeakMap<readonly string[], MapShower>>();

/**
 * `shownText` of `map` under `langs`, worked out once and answered for every
 * language from it: `clean_trans(name, [lang] + langs)` is the language's own
 * value where the map holds one (not `None`), else the first of `langs` the map
 * holds, else its least key; and the `default` table's text, which a blank
 * falls back to, is one text whatever the language. So each language is
 * examined once a map, never once a language of each other language.
 */
function mapShower(map: TextMap, langs: readonly string[]): MapShower {
	let byLangs = showers.get(map);
	if (byLangs === undefined) {
		byLangs = new WeakMap();
		showers.set(map, byLangs);
	}
	const known = byLangs.get(langs);
	if (known !== undefined) return known;
	chargeWork("visit", 1 + langs.length);
	const holds = (lang: string) =>
		Object.hasOwn(map, lang) && map[lang] !== null;
	let first: string | undefined;
	for (const lang of langs)
		if (holds(lang)) {
			first = lang;
			break;
		}
	if (first === undefined) {
		// `sorted(name.items())[0]`: the least key, whatever its value, `None` included.
		const keys = Object.keys(map);
		chargeWork("visit", keys.length);
		first = keys.sort(compareCodePoints)[0];
	}
	const otherwise = first;
	const printedBy = new Map<string, HqText>();
	/** `clean_trans(map, [lang] + langs)`. */
	const ownText = (lang: string): HqText => {
		const chosen = holds(lang) ? lang : otherwise;
		if (chosen === undefined) return { ok: true, text: "" };
		let text = printedBy.get(chosen);
		if (text === undefined) {
			text = printed(map, chosen, "");
			printedBy.set(chosen, text);
		}
		return text;
	};
	let fallback: HqText | undefined;
	const defaultTable = (): HqText => {
		if (fallback !== undefined) return fallback;
		const read = new Map<string, HqText>();
		let chosen: HqText | undefined;
		for (let index = langs.length - 1; index >= 0; index--) {
			const lc = langs[index] as string;
			if (lc === DEFAULT_LOCALE) continue;
			const own = ownText(lc);
			let value = read.get(lc);
			if (value === undefined) {
				// The merge reads each language's table back through `loads`, so a text Python reads
				// as blank is `""` there and every other loses the spaces at its end.
				value = own.ok ? { ok: true, text: defaultTableText(own.text) } : own;
				read.set(lc, value);
			}
			// `if not (val == '' and key in messages)`
			if (!(value.ok && value.text === "" && chosen !== undefined))
				chosen = value;
		}
		fallback = chosen ?? { ok: true, text: "" };
		return fallback;
	};
	const shower: MapShower = {
		shown(lang) {
			const own = ownText(lang);
			return !own.ok || own.text !== "" ? own : defaultTable();
		},
	};
	byLangs.set(langs, shower);
	return shower;
}

/**
 * The source text and the translations Nova records for one stored map, so
 * that printing the source text for every language without a translation, and
 * its translation for every other, shows in each of `langs` exactly what
 * HQ's build shows (`shownText`). The source is the text shown in
 * `sourceLang`; a language of `langs` (but `sourceLang` and `default`) gets a
 * translation only where its shown text differs from the source.
 */
export function sourceAndTranslations(
	stored: unknown,
	langs: readonly string[],
	sourceLang: string,
): HqSourceAndTranslations {
	const source = shownText(stored, sourceLang, langs);
	if (!source.ok) return source;
	const translations = recordFromEntries<string>([]);
	for (const lang of langs) {
		if (lang === sourceLang || lang === DEFAULT_LOCALE) continue;
		const shown = shownText(stored, lang, langs);
		if (!shown.ok) return shown;
		if (shown.text !== source.text) translations[lang] = shown.text;
	}
	return { ok: true, source: source.text, translations };
}
