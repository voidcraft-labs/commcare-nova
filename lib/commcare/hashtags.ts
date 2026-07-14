/**
 * Vellum hashtag expansion — converts #form/, #case/, and #user/ shorthand to full XPath.
 *
 * Uses the Lezer XPath parser to identify HashtagRef nodes and their structured
 * children (HashtagType, HashtagSegment), then surgically replaces them with
 * expanded XPath. The shorthand survives on the wire only in HQ's EDITOR
 * vocabulary — `vellum:*` shadow attributes via
 * `hashtags/formContext.ts::vellumShorthandInContext`, and the
 * `case_references_data.load` map via {@link hqLoadReference} — never as Nova's
 * per-case-type namespaces, which the editor cannot parse.
 */
import { parser } from "@/lib/commcare/xpath";

// Pre-resolve node types — zero string comparisons at runtime
const T = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((t) => t.name === name);
		if (!found) throw new Error(`Missing parser node type: ${name}`);
		return found;
	};
	return {
		HashtagRef: one("HashtagRef"),
		HashtagType: one("HashtagType"),
		HashtagSegment: one("HashtagSegment"),
	};
})();

// ── Case-loading selector primitives ─────────────────────────────────
// Single source of truth for the casedb `<case>` selector. Both the
// `#case/` transforms-metadata prefix below and `expandCaseHashtag`'s
// relationship walk compose from these, so the loaded-case shape cannot
// drift between the metadata string and the emitted XPath.
const CASEDB_CASE = "instance('casedb')/casedb/case";
const CURRENT_CASE_ID = "instance('commcaresession')/session/data/case_id";

/** A casedb `<case>` selected by its `@case_id` expression. */
function caseById(idExpr: string): string {
	return `${CASEDB_CASE}[@case_id = ${idExpr}]`;
}

/** HQ-shaped transforms metadata — the static prefixes the head-level
 *  `<vellum:hashtagTransforms>` element composes from. */
export const VELLUM_HASHTAG_TRANSFORMS = {
	prefixes: {
		// The loaded case (`#case/<prop>`) — composed from the selector
		// primitives so it stays identical to `expandCaseHashtag`'s zero-hop
		// output by construction.
		"#case/": `${caseById(CURRENT_CASE_ID)}/`,
		"#user/":
			"instance('casedb')/casedb/case[@case_type = 'commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/",
	},
} as const;

/**
 * HQ's editor case vocabulary, by parent-index hop depth. The form designer
 * knows exactly three case generations — `commcare-hq/corehq/apps/app_manager/
 * app_schemas/casedb_schema.py::_get_case_schema_subsets` builds its data
 * sources from `generation_names = ['case', 'parent', 'grandparent']` — and its
 * XPath engine resolves an unlisted hashtag by prefix lookup against exactly
 * these (`Vellum/src/xpath.js::hashtagToXPath`). A deeper walk has NO hashtag
 * spelling the editor can expand, so depth ≥ 3 has no entry here.
 */
export const VELLUM_CASE_GENERATION_PREFIXES = [
	"#case/",
	"#case/parent/",
	"#case/grandparent/",
] as const;

/**
 * Flat-prefix expansion by hashtag type, for the types whose expansion is a
 * simple prefix + property path. `#form/` is a trivial `/data/` expansion;
 * `#user/` resolves to the commcare-user case. `#case/` is NOT here — it can
 * carry leading relationship segments (`parent`/`grandparent`) that nest the
 * selector, so it routes through `expandCaseHashtag` instead.
 */
const EXPANSIONS = new Map<string, string>([
	["form", "/data/"],
	["user", VELLUM_HASHTAG_TRANSFORMS.prefixes["#user/"]],
]);

// ── Case relationship traversal ──────────────────────────────────────

/**
 * The one case-index relationship Nova models in hashtags. A leading
 * `#case/parent/...` segment walks to the loaded case's parent through the
 * case INDEX (`/index/parent`) — NOT a literal `parent` child element of
 * `<case>` — matching commcare-hq's `#parent` hashtag (`app_manager/xpath.py`:
 * `CaseIDXPath(case + '/index/parent').case()`).
 *
 * `parent` is a CommCare-reserved case property (`RESERVED_CASE_PROPERTIES`),
 * so the field-authoring guard rejects it as a real property name — which is
 * what makes a leading `parent` segment unambiguously a relationship walk and
 * not a property read. Deeper ancestry chains the segment: `#case/parent/parent/<prop>`
 * is the grandparent. We deliberately do NOT add a `grandparent` keyword:
 * CommCare reserves no such word (so a property COULD be named `grandparent`,
 * and a keyword would silently shadow it), and chaining `parent` covers every
 * depth. `host` and other index relationships aren't modeled yet.
 */
const CASE_PARENT_SEGMENT = "parent";

/**
 * The core case-loading walk, addressed by hop depth: `hops` parent-index hops
 * up from the form's loaded case, then `propPath` read off the target case.
 * Zero hops → the plain loaded-case selector (the same shape the `#case/`
 * transforms prefix carries, since both compose from `caseById`). N hops → N
 * nested `caseById(...)/index/parent` walks from the current case to the target
 * ancestor case.
 *
 * The single wire-shape authority for BOTH ways a case is addressed: the legacy
 * `#case/parent…/<prop>` path counts leading `parent` segments into `hops`
 * (`expandCaseHashtag`), and the per-case-type path
 * (`hashtags/formContext.ts::expandHashtagsInContext`) maps a case-type
 * namespace to its `reachableCaseTypes` depth and passes that depth as `hops`.
 * Routing both through here is what makes `#<own_type>/<prop>` byte-identical to
 * `#case/<prop>` and `#<ancestor>/<prop>` byte-identical to the matching
 * `#case/parent…/<prop>` BY CONSTRUCTION, not by parallel walks that could drift.
 */
export function expandCaseToWire(hops: number, propPath: string): string {
	// Walk to the target case's id — one `/index/parent` per hop; zero hops
	// leaves it at the current case. Everything flows through `caseById`, so the
	// zero-hop output is byte-for-byte the loaded-case prefix, which the
	// `#case/<prop>` regression test pins — transitively guarding these selector
	// primitives against drift.
	let idExpr = CURRENT_CASE_ID;
	for (let h = 0; h < hops; h++) {
		idExpr = `${caseById(idExpr)}/index/parent`;
	}
	// A walk with no trailing property (a bare `#case/parent` relationship)
	// resolves to the related case node itself.
	return propPath ? `${caseById(idExpr)}/${propPath}` : caseById(idExpr);
}

/**
 * Split a literal `#case/...` hashtag's segments into the parent-index hop count
 * (the leading `parent` relationship segments) and the property path read off
 * the target case. The context-aware expander reuses this so its literal-`#case/`
 * branch counts hops identically to `expandCaseHashtag`.
 */
export function splitCaseSegments(segments: string[]): {
	hops: number;
	propPath: string;
} {
	let firstProp = 0;
	while (segments[firstProp] === CASE_PARENT_SEGMENT) firstProp++;
	return { hops: firstProp, propPath: segments.slice(firstProp).join("/") };
}

/**
 * Expand a `#case/...` hashtag's segments to full casedb XPath, resolving any
 * leading `parent` relationship segments through the case index into the hop
 * count `expandCaseToWire` walks; the remaining segments are the property path.
 */
export function expandCaseHashtag(segments: string[]): string {
	const { hops, propPath } = splitCaseSegments(segments);
	return expandCaseToWire(hops, propPath);
}

/**
 * Apply ALREADY-POSITION-SORTED edits in reverse order to preserve
 * source offsets.
 *
 * Deliberately NOT the rewriters' self-sorting `applyEdits`
 * (`lib/preview/xpath/rewrite.ts`): the sole producer here is
 * `tree.iterate`, which visits `HashtagRef`s in document order, so the
 * edit list arrives sorted by construction and this helper leans on
 * that precondition instead of re-sorting — the name carries the
 * contract.
 */
function applyPresortedEdits(
	source: string,
	edits: Array<{ from: number; to: number; text: string }>,
): string {
	if (edits.length === 0) return source;
	let result = source;
	for (let i = edits.length - 1; i >= 0; i--) {
		const { from, to, text } = edits[i];
		result = result.slice(0, from) + text + result.slice(to);
	}
	return result;
}

/**
 * Walk every `HashtagRef` in `expr` (via the Lezer XPath parser, never a
 * substring scan — `#case/case_id` and `#case/case_id_x` differ only at a
 * segment boundary the parser respects) and replace each through `resolve`.
 * The resolver receives the hashtag's type name + segment strings and returns
 * the replacement XPath, or `undefined` to leave that ref verbatim.
 *
 * The single tree-walk shared by the context-free {@link expandHashtags} and
 * the context-aware `hashtags/formContext.ts::expandHashtagsInContext`, so the
 * two can never drift in how they locate hashtag spans.
 */
export function rewriteHashtags(
	expr: string,
	resolve: (typeName: string, segments: string[]) => string | undefined,
): string {
	if (!expr) return expr;

	const tree = parser.parse(expr);
	const edits: Array<{ from: number; to: number; text: string }> = [];

	// tree.iterate visits in document order — edits are position-sorted for reverse apply
	tree.iterate({
		enter(node) {
			if (node.type === T.HashtagRef) {
				const ref = node.node;
				const type = ref.getChild(T.HashtagType.id);
				if (!type) return;
				const typeName = expr.slice(type.from, type.to);
				const segments = ref
					.getChildren(T.HashtagSegment.id)
					.map((s) => expr.slice(s.from, s.to));
				const text = resolve(typeName, segments);
				if (text !== undefined) {
					edits.push({ from: node.from, to: node.to, text });
				}
				return false; // don't descend into children
			}
		},
	});

	return applyPresortedEdits(expr, edits);
}

/**
 * Flat-prefix resolution for the namespaces whose expansion is a simple
 * `prefix + property path` — `#form/` and `#user/`. Returns `undefined` for any
 * other namespace; `#case/` and the per-case-type namespaces carry
 * relationship / scope that needs the `expandCaseToWire` walk instead.
 */
export function resolveFlatHashtag(
	typeName: string,
	segments: string[],
): string | undefined {
	const prefix = EXPANSIONS.get(typeName);
	return prefix !== undefined ? prefix + segments.join("/") : undefined;
}

/**
 * Expand `#form/`, `#case/`, and `#user/` hashtags to full XPath. Context-free:
 * it CANNOT resolve per-case-type namespaces (`#<type>/<prop>`) because those
 * need the form's reachable-case-type depths — that resolution lives in
 * `hashtags/formContext.ts::expandHashtagsInContext`. The literal `#case/`
 * branch stays as a transitional safety net for any un-migrated reference.
 */
export function expandHashtags(expr: string): string {
	return rewriteHashtags(expr, (typeName, segments) =>
		typeName === "case"
			? expandCaseHashtag(segments)
			: resolveFlatHashtag(typeName, segments),
	);
}

/**
 * Extract every case-bound hashtag reference from XPath expressions: `#case/…`,
 * `#user/…`, and every `#<case_type>/…` per-type ref — i.e. every namespace
 * EXCEPT `#form/`, which resolves to a plain in-form `/data/` path that carries
 * no HQ-side hashtag metadata or `case_references_data.load` entry. Feeds both
 * the head-level `<vellum:hashtags>` map and `formActions.ts`'s load map (each
 * translating the raw refs into HQ vocabulary before emission).
 */
export function extractHashtags(exprs: string[]): string[] {
	const hashtags = new Set<string>();
	for (const expr of exprs) {
		if (!expr) continue;
		parser.parse(expr).iterate({
			enter(node) {
				if (node.type === T.HashtagRef) {
					const type = node.node.getChild(T.HashtagType.id);
					if (!type) return false;
					const typeName = expr.slice(type.from, type.to);
					if (typeName !== "form") {
						hashtags.add(expr.slice(node.from, node.to));
					}
					return false;
				}
			},
		});
	}
	return [...hashtags];
}

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
 * is string-recorded metadata, not editor-parsed XPath. `#case/` / `#user/`
 * refs are already the target vocabulary and pass through verbatim, as does a
 * ref whose namespace isn't a reachable case type (the deep validator rejects
 * that doc; this stays total).
 */
export function hqLoadReference(
	ref: string,
	caseTypeDepths: ReadonlyMap<string, number>,
): string {
	const ns = hashtagNamespace(ref);
	if (ns === undefined) return ref;
	// `#case` / `#user` are already the target vocabulary — checked BEFORE the
	// depths lookup, mirroring `expandHashtagsInContext`'s precedence for a
	// case type literally named `case`.
	if (ns === "case" || ns === "user") return ref;
	const depth = caseTypeDepths.get(ns);
	if (depth === undefined) return ref;
	const rest = ref.slice(ns.length + 2);
	const prefix =
		VELLUM_CASE_GENERATION_PREFIXES[depth] ??
		`#case/${"parent/".repeat(depth)}`;
	return prefix + rest;
}

/**
 * Build the head-level `<vellum:hashtagTransforms>` payload for a form: the
 * prefix → expansion table covering every generation prefix the form's
 * (already-editor-vocabulary) refs actually use, plus `#user/` when referenced.
 *
 * This is the same `{prefixes}` JSON vanilla Vellum serializes
 * (`Vellum/src/form.js::knownHashtagTransforms` → `writer.js`) and reads back
 * as its pre-datasources fallback (`parser.js::initHashtags`). Each case
 * generation maps to the depth-N `caseById` walk `expandCaseToWire` emits, so
 * the table's expansion is byte-identical to the expanded attributes the binds
 * carry.
 */
export function buildVellumTransforms(editorRefs: Iterable<string>): {
	prefixes: Record<string, string>;
} {
	const prefixes: Record<string, string> = {};
	for (const ref of editorRefs) {
		if (ref.startsWith("#user/")) {
			prefixes["#user/"] = VELLUM_HASHTAG_TRANSFORMS.prefixes["#user/"];
			continue;
		}
		// Longest generation prefix first — every `#case/parent/…` ref also
		// starts with `#case/`.
		for (
			let depth = VELLUM_CASE_GENERATION_PREFIXES.length - 1;
			depth >= 0;
			depth--
		) {
			if (ref.startsWith(VELLUM_CASE_GENERATION_PREFIXES[depth])) {
				prefixes[VELLUM_CASE_GENERATION_PREFIXES[depth]] =
					`${expandCaseToWire(depth, "")}/`;
				break;
			}
		}
	}
	return { prefixes };
}
