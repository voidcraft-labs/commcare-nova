/**
 * Vellum hashtag expansion — converts #form/, #case/, and #user/ shorthand to full XPath.
 *
 * Uses the Lezer XPath parser to identify HashtagRef nodes and their structured
 * children (HashtagType, HashtagSegment), then surgically replaces them with
 * expanded XPath. The shorthand is preserved in vellum:* attributes for
 * round-tripping back to the editor.
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

/** HQ-shaped transforms metadata — serialized to vellum:hashtagTransforms on binds. */
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

/** Returns true if the expression contains any HashtagRef nodes. */
export function hasHashtags(expr: string): boolean {
	if (!expr) return false;
	const cursor = parser.parse(expr).cursor();
	do {
		if (cursor.type === T.HashtagRef) return true;
	} while (cursor.next());
	return false;
}

/**
 * Extract every case-bound hashtag reference from XPath expressions: `#case/…`,
 * `#user/…`, and every `#<case_type>/…` per-type ref — i.e. every namespace
 * EXCEPT `#form/`, which resolves to a plain in-form `/data/` path that carries
 * no HQ-side `vellum:hashtags` metadata or `case_references_data.load` entry.
 * Feeds both the bind's `vellum:hashtags` map and `formActions.ts`'s load map.
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
 * Build a bind's `vellum:hashtagTransforms` metadata: the HQ-Vellum round-trip
 * table mapping each referenced hashtag prefix to the XPath it expands to.
 *
 * Starts from the static `#case/` + `#user/` base (`VELLUM_HASHTAG_TRANSFORMS`),
 * then adds a per-type prefix for every case-type namespace actually referenced
 * in `referencedHashtags`, each the depth-N `caseById` walk `expandCaseToWire`
 * emits — so HQ's editor round-trips `#<type>/` to the same XPath the bind
 * carries. Own-type (depth 0) yields the same prefix string as `#case/`.
 *
 * A bind that references no per-type namespace returns the base unchanged, so
 * its serialized metadata is byte-identical to the pre-per-type output. Emitting
 * only the referenced types (not every reachable type) keeps the metadata
 * minimal and matches the existing "transforms only when a ref needs them"
 * posture.
 */
export function buildHashtagTransforms(
	referencedHashtags: string[],
	caseTypeDepths: ReadonlyMap<string, number>,
): { prefixes: Record<string, string> } {
	const prefixes: Record<string, string> = {
		...VELLUM_HASHTAG_TRANSFORMS.prefixes,
	};
	for (const ref of referencedHashtags) {
		const ns = hashtagNamespace(ref);
		if (ns === undefined) continue;
		const depth = caseTypeDepths.get(ns);
		if (depth === undefined) continue;
		prefixes[`#${ns}/`] = `${expandCaseToWire(depth, "")}/`;
	}
	return { prefixes };
}
