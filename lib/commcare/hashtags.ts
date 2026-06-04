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

/** Hashtag types that need HQ-side vellum:hashtags metadata (non-trivial expansions). */
const HQ_HASHTAG_TYPES = new Set(["case", "user"]);

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
 * Expand a `#case/...` hashtag's segments to full casedb XPath, resolving any
 * leading `parent` relationship segments through the case index. Zero parent
 * segments → the plain loaded-case selector (the same shape the `#case/`
 * transforms prefix carries, since both compose from `caseById`). N parents →
 * N nested `caseById(...)/index/parent` walks from the current case to the
 * target ancestor case, then the remaining property path read off that case.
 */
function expandCaseHashtag(segments: string[]): string {
	let firstProp = 0;
	while (segments[firstProp] === CASE_PARENT_SEGMENT) firstProp++;
	const hops = firstProp;
	const propPath = segments.slice(firstProp).join("/");

	// Walk to the target case's id — one `/index/parent` per parent hop; zero
	// hops leaves it at the current case. Everything flows through `caseById`,
	// so the zero-hop output is byte-for-byte the loaded-case prefix, which the
	// `#case/<prop>` regression test pins — transitively guarding these
	// selector primitives against drift.
	let idExpr = CURRENT_CASE_ID;
	for (let h = 0; h < hops; h++) {
		idExpr = `${caseById(idExpr)}/index/parent`;
	}
	// A bare `#case/parent` (relationship with no trailing property) resolves
	// to the related case node itself.
	return propPath ? `${caseById(idExpr)}/${propPath}` : caseById(idExpr);
}

/** Apply edits in reverse order to preserve source offsets. */
function applyEdits(
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

/** Expand #form/, #case/, and #user/ hashtags to full XPath in an expression. */
export function expandHashtags(expr: string): string {
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
				const segments = ref.getChildren(T.HashtagSegment.id);
				const typeName = expr.slice(type.from, type.to);
				const segmentStrings = segments.map((s) => expr.slice(s.from, s.to));
				// `case` routes through the relationship-aware expander; `form`
				// and `user` are flat prefix + path.
				let text: string | undefined;
				if (typeName === "case") {
					text = expandCaseHashtag(segmentStrings);
				} else {
					const prefix = EXPANSIONS.get(typeName);
					if (prefix !== undefined) text = prefix + segmentStrings.join("/");
				}
				if (text !== undefined) {
					edits.push({ from: node.from, to: node.to, text });
				}
				return false; // don't descend into children
			}
		},
	});

	return applyEdits(expr, edits);
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

/** Extract all #case/... and #user/... hashtag references from XPath expressions. */
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
					if (HQ_HASHTAG_TYPES.has(typeName)) {
						hashtags.add(expr.slice(node.from, node.to));
					}
					return false;
				}
			},
		});
	}
	return [...hashtags];
}
