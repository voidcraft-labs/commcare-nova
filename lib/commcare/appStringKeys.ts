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
