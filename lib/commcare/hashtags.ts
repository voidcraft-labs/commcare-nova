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

/**
 * HQ's `case_references_data.load` entry for one typed case read, or
 * `undefined` where the form reaches no case of that type. HQ parses a load
 * entry's case type by prefix — ONLY `#case/` and `#user/` are recognized
 * (`commcare-hq/corehq/apps/app_manager/app_schemas/app_case_metadata.py::
 * _parse_case_type`), with a leading `grandparent/` normalized to
 * `parent/parent/` — so a read of any case type lands as its
 * `#case/`-generation equivalent, whatever the type is called.
 *
 * Depth ≥ 3 (beyond HQ's three named generations) falls back to the
 * parent-chain spelling (`#case/parent/parent/parent/<prop>`) — HQ's own
 * normalization shows chains are its internal canonical form, and the load map
 * is string-recorded metadata, not editor-parsed XPath. This projects the
 * typed read, never reference text.
 */
export function hqLoadReference(
	caseType: string,
	property: string,
	caseTypeDepths: ReadonlyMap<string, number>,
): string | undefined {
	const depth = caseTypeDepths.get(caseType);
	if (depth === undefined) return undefined;
	const prefix =
		HQ_CASE_GENERATION_PREFIXES[depth] ?? `#case/${"parent/".repeat(depth)}`;
	return prefix + property;
}
