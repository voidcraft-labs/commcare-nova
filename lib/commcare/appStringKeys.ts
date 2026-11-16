/**
 * Who owns one key of an app's `translations` on CommCare HQ.
 *
 * HQ's `translations` holds, per language, overrides of the app's strings.
 * An update replaces the key whole, so a publish carries the target's own
 * keys back and writes only Nova's:
 *
 * - `generated`: a key matching, at its start, a pattern HQ registers for a
 *   string it generates (`id_strings.py::REGEXES`), other than the
 *   `android.package.name.` pattern. HQ writes each such string itself, and
 *   a stored value outranks the field that owns it, so after a rename or a
 *   reorder a carried one would name the wrong thing. Nova writes only
 *   `app.display.name` and `homescreen.title`, where a language localizes
 *   the app's name.
 * - `language-name`: a key equal to a language's wire code. Nova writes every
 *   current language's name.
 * - `target`: anything else, every runtime UI-catalog key such as
 *   `home.start` and `android.package.name.*` among them. HQ's value is kept.
 *
 * The patterns are data: the surface's `app-string-id:<pattern>` items, one
 * per entry of `REGEXES`, with `*` for HQ's `%s` (any text) and `#` for `%d`
 * (digits). The weekly pin pull request regenerates them from HQ's source.
 */

import { isPythonSpace } from "./localeFile";
import surface from "./surface/surface.json";

export type TranslationKeyOwner = "generated" | "language-name" | "target";

const APP_STRING_ID_PREFIX = "app-string-id:";

/** Both a generated pattern and a runtime UI-catalog key: the target's. */
const TARGET_OWNED_PATTERN = "android.package.name.*";

function escapeLiteral(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One surface pattern as HQ's `re.match` reads it: anchored at the start only. */
function patternMatcher(pattern: string): RegExp {
	let source = "^";
	for (const char of pattern) {
		if (char === "*") source += ".*";
		else if (char === "#") source += "[0-9]+";
		else source += escapeLiteral(char);
	}
	return new RegExp(source);
}

/** The generated patterns, from the surface, in its order. */
export const GENERATED_APP_STRING_PATTERNS: readonly string[] = Object.keys(
	(surface as { readonly items: Readonly<Record<string, unknown>> }).items,
)
	.filter((key) => key.startsWith(APP_STRING_ID_PREFIX))
	.map((key) => key.slice(APP_STRING_ID_PREFIX.length))
	.filter((pattern) => pattern !== TARGET_OWNED_PATTERN);

const GENERATED_MATCHERS = GENERATED_APP_STRING_PATTERNS.map(patternMatcher);

/**
 * The owner of `key` in an app whose languages, Nova's and the target's
 * current ones together, are `codes`.
 */
export function translationKeyOwner(
	key: string,
	codes: Iterable<string>,
): TranslationKeyOwner {
	if (GENERATED_MATCHERS.some((matcher) => matcher.test(key))) {
		return "generated";
	}
	for (const code of codes) if (code === key) return "language-name";
	return "target";
}

const UI_STRING_PREFIX = "ui-string:";

/** The surface's `ui-string:` items a runtime reads (they carry a `readBy`). */
const RUNTIME_UI_STRING_ITEMS: readonly string[] = Object.entries(
	(
		surface as {
			readonly items: Readonly<
				Record<string, { readonly readBy?: readonly string[] }>
			>;
		}
	).items,
)
	.filter(
		([key, item]) =>
			key.startsWith(UI_STRING_PREFIX) && (item.readBy?.length ?? 0) > 0,
	)
	.map(([key]) => key.slice(UI_STRING_PREFIX.length));

/** Each key a runtime reads under its own name. */
const RUNTIME_UI_STRING_KEYS: ReadonlySet<string> = new Set(
	RUNTIME_UI_STRING_ITEMS.filter((name) => !name.endsWith(".*")),
);

/** Each prefix a runtime reads keys under: a `<prefix>.*` item, kept with its dot. */
const RUNTIME_UI_STRING_PREFIXES: readonly string[] =
	RUNTIME_UI_STRING_ITEMS.filter((name) => name.endsWith(".*")).map((name) =>
		name.slice(0, -1),
	);

/**
 * Whether a runtime reads `key` as one of its own UI strings: the surface
 * holds an item `ui-string:<key>` that a runtime reads, or an item
 * `ui-string:<prefix>.*` that a runtime reads whose prefix `key` starts with.
 * The proof lane reads the same family by the same rule.
 */
export function isRuntimeUiStringKey(key: string): boolean {
	if (RUNTIME_UI_STRING_KEYS.has(key)) return true;
	return RUNTIME_UI_STRING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

interface UiStringFacts {
	readonly catalogs?: readonly string[];
	readonly hqBuildVersions?: readonly string[];
}

/** Where the surface names a catalog file of HQ's `commcare-translations`. */
const HQ_CATALOG_DIRECTORY = "commcare-hq/submodules/commcare-translations/";

/** The surface's name for the ids `id_strings.REGEX_DEFAULT_VALUES` gives every language. */
const HQ_REGEX_DEFAULT_VALUES = "commcare-hq id_strings.REGEX_DEFAULT_VALUES";

/** A surface name as the upstream text spells it: the surface percent-encodes some characters. */
function decodedSurfaceName(name: string): string {
	try {
		return decodeURIComponent(name);
	} catch {
		return name;
	}
}

/** Each `ui-string:` item's facts, by the id it names. */
const UI_STRING_FACTS: ReadonlyMap<string, UiStringFacts> = new Map(
	Object.entries(
		(surface as { readonly items: Readonly<Record<string, UiStringFacts>> })
			.items,
	)
		.filter(([key]) => key.startsWith(UI_STRING_PREFIX))
		.map(([key, facts]) => [
			decodedSurfaceName(key.slice(UI_STRING_PREFIX.length)),
			facts,
		]),
);

/** The catalog files HQ's `commcare-translations` holds, each named by some item. */
const HQ_CATALOG_FILES: ReadonlySet<string> = new Set(
	[...UI_STRING_FACTS.values()].flatMap((facts) =>
		(facts.catalogs ?? []).filter((catalog) =>
			catalog.startsWith(HQ_CATALOG_DIRECTORY),
		),
	),
);

/**
 * Whether CommCare HQ's build may write its own catalog text under `key` in
 * the strings it builds for the language whose wire code is `code`.
 *
 * `SelectKnownAppStrings.app_strings_parts` (the one translation strategy an
 * app Nova reads holds) puts, in each language's strings, the text of every
 * key some language's `translations` holds that the language's catalog holds
 * (`commcare_translations.load_translations(code, version=2)`): `pt` reads
 * `por`; English reads the catalog of the app's CommCare version, which
 * Nova does not know, so a key any English catalog holds may be held; any
 * other language reads the first of `messages_<code>-2.txt` and
 * `messages_<code>-1.txt` that exists. `get_default_translations` adds the
 * ids of `id_strings.REGEX_DEFAULT_VALUES` to every language's catalog.
 */
export function hqCatalogMayHold(key: string, code: string): boolean {
	const facts = UI_STRING_FACTS.get(key);
	if (facts === undefined) return false;
	const catalogs = facts.catalogs ?? [];
	if (catalogs.includes(HQ_REGEX_DEFAULT_VALUES)) return true;
	const lang = code === "pt" ? "por" : code;
	if (lang === "en" && (facts.hqBuildVersions?.length ?? 0) > 0) return true;
	const file = [2, 1]
		.map((version) => `${HQ_CATALOG_DIRECTORY}messages_${lang}-${version}.txt`)
		.find((name) => HQ_CATALOG_FILES.has(name));
	return file !== undefined && catalogs.includes(file);
}

/**
 * The text a project space holds under its own keys that CommCare HQ's build
 * writes into an app's `default` strings, for an app whose languages are
 * `languages` (wire codes, the default language first) and whose project
 * space holds `uiText` (per language code, each key it holds text under).
 *
 * `AppStringsBase.create_default_app_strings` reads back each language's
 * strings as written (`commcare_translations.py::dumps`, then `loads`, which
 * keeps of each text what `defaultTableText` keeps) and merges them, the last
 * language first, never putting a blank text over one already merged. So a
 * key takes the first language's text that is not blank, its catalog's
 * included, and a blank only where no language holds more. Nova writes no
 * catalog text: where a language's catalog may hold the key before any
 * language that holds text for it, the key takes nothing here, and a phone
 * shows its own wording. A language that holds a blank text gives none, its
 * catalog's included, because its own stored text replaces its catalog's.
 */
export function defaultAppStringsHeldText(
	uiText: Readonly<Record<string, Readonly<Record<string, string>>>>,
	languages: readonly string[],
): Readonly<Record<string, string>> {
	const tables = languages.map(
		(code) => [code, Object.hasOwn(uiText, code) ? uiText[code] : {}] as const,
	);
	const keys = new Set(tables.flatMap(([, table]) => Object.keys(table)));
	const held: [string, string][] = [];
	for (const key of keys) {
		let blank = false;
		let text: string | undefined;
		for (const [code, table] of tables) {
			if (Object.hasOwn(table, key)) {
				const read = defaultTableText(table[key]);
				if (read !== "") {
					text = read;
					break;
				}
				blank = true;
				continue;
			}
			if (hqCatalogMayHold(key, code)) {
				blank = false;
				break;
			}
		}
		if (text !== undefined) held.push([key, text]);
		else if (blank) held.push([key, ""]);
	}
	return Object.fromEntries(held);
}

/**
 * What HQ's default merge reads back of one language's stored text: the line
 * `dumps` writes for it, stripped by `load` (`line.strip()`). A text Python
 * reads as blank is written as one non-breaking space and read back as `""`;
 * any other loses the run of spaces at its end, a line break excepted,
 * because `dumps` writes a line break as the two characters `\n`.
 */
function defaultTableText(text: string): string {
	if ([...text].every((char) => isPythonSpace(char.charCodeAt(0)))) return "";
	let end = text.length;
	while (end > 0) {
		const code = text.charCodeAt(end - 1);
		if (code === 0x0a || !isPythonSpace(code)) break;
		end -= 1;
	}
	return text.slice(0, end);
}
