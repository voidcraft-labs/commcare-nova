/**
 * HQ's private hashtag metadata vocabulary.
 *
 * `hqLoadReference` projects typed case reads into the strings HQ's app
 * summary reads in `case_references_data.load`. `VELLUM_HASHTAG_TRANSFORMS`
 * describes the editor's worker-record prefix. Executable form expressions
 * are emitted from typed wire trees by `xpath/wire/fromExpression.ts`.
 */

import { USERCASE_CASE_SELECTOR } from "./usercaseWire";
import { serializeWire } from "./xpath/wire/serialize";

/** The prefix `#user/` expands to. */
export const VELLUM_HASHTAG_TRANSFORMS = {
	prefixes: {
		// The same selector the suite's `usercase_id` datum and its assertion
		// are built from, so the hashtag cannot come to mean a different case
		// than the entry guards.
		"#user/": `${serializeWire(USERCASE_CASE_SELECTOR, { target: "xform", constraint: false }).text}/`,
	},
} as const;

/**
 * HQ's editor case vocabulary, by parent-index hop depth. The form designer
 * knows exactly three case generations — `commcare-hq/corehq/apps/app_manager/
 * app_schemas/casedb_schema.py::_get_case_schema_subsets` builds its data
 * sources from `generation_names = ['case', 'parent', 'grandparent']` — and its
 * XPath engine resolves an unlisted hashtag by prefix lookup against exactly
 * these (`Vellum/src/xpath.js::hashtagToXPath`). A deeper walk has NO hashtag
 * spelling the editor can expand, so depth ≥ 3 has no entry here. The load
 * metadata below can still name deeper walks with repeated parent segments.
 */
const HQ_CASE_GENERATION_PREFIXES = [
	"#case/",
	"#case/parent/",
	"#case/grandparent/",
] as const;

/** Parse the namespace out of a full hashtag ref string (`#mother/x` → `mother`).
 *  Returns `undefined` for a malformed ref (no leading `#` or no segment). */
function hashtagNamespace(ref: string): string | undefined {
	const slash = ref.indexOf("/");
	return ref.startsWith("#") && slash > 1 ? ref.slice(1, slash) : undefined;
}

/**
 * Translate one extracted hashtag ref into the vocabulary HQ's
 * `case_references_data.load` map speaks. HQ parses a load entry's case type
 * by prefix — ONLY `#case/` and `#user/` are recognized
 * (`commcare-hq/corehq/apps/app_manager/app_schemas/app_case_metadata.py::
 * _parse_case_type`), with a leading `grandparent/` normalized to
 * `parent/parent/` — so a per-case-type ref must land there as its
 * `#case/`-generation equivalent or HQ records the raw `#<type>/…` string as a
 * literal property name of the module's case type.
 *
 * Depth ≥ 3 (beyond HQ's three named generations) falls back to the
 * parent-chain spelling (`#case/parent/parent/parent/<prop>`) — HQ's own
 * normalization shows chains are its internal canonical form, and the load map
 * is string-recorded metadata, not editor-parsed XPath. `#user/` is already
 * target vocabulary and passes through. Literal authored `#case/` is rejected:
 * only this function's typed-reference projection may generate it.
 */
export function hqLoadReference(
	ref: string,
	caseTypeDepths: ReadonlyMap<string, number>,
): string {
	const ns = hashtagNamespace(ref);
	if (ns === undefined) return ref;
	if (ns === "search") {
		throw new Error(
			"A #search/ reference reads the search-input instance, not a case; it has no HQ load entry",
		);
	}
	if (ns === "case") {
		throw new Error(
			'Authored "#case/..." is not a Nova reference; HQ case vocabulary is generated only from an explicit case-type namespace',
		);
	}
	if (ns === "user") return ref;
	const depth = caseTypeDepths.get(ns);
	if (depth === undefined) return ref;
	const rest = ref.slice(ns.length + 2);
	const prefix =
		HQ_CASE_GENERATION_PREFIXES[depth] ?? `#case/${"parent/".repeat(depth)}`;
	return prefix + rest;
}
