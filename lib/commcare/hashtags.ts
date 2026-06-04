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

/** HQ-shaped transforms metadata — serialized to vellum:hashtagTransforms on binds. */
export const VELLUM_HASHTAG_TRANSFORMS = {
	prefixes: {
		"#case/":
			"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/",
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
 * Case-index relationship segments and the number of `index/parent` hops
 * each resolves to. `#case/parent/<prop>` reads a property off the loaded
 * case's parent; `#case/grandparent/<prop>` off the parent's parent.
 * CommCare resolves these through the case INDEX — not as a literal `parent`
 * child element of `<case>` — matching commcare-hq's `#parent`/`#grandparent`
 * hashtags (`app_manager/xpath.py`: `CaseIDXPath(case + '/index/parent').case()`)
 * and Vellum's data-source tree. A `parent/parent` chain reaches the same
 * case as `grandparent`, so both spellings are accepted.
 */
const CASE_RELATIONSHIP_HOPS = new Map<string, number>([
	["parent", 1],
	["grandparent", 2],
]);

// Pieces of the case-loading selector, kept in lockstep with
// `VELLUM_HASHTAG_TRANSFORMS.prefixes["#case/"]` — that prefix IS
// `${caseById(CURRENT_CASE_ID)}/`. The zero-hop expansion reuses the prefix
// verbatim (byte-identical to the historical output, guarded by test);
// each relationship hop nests one more `caseById(...)/index/parent` walk.
const CASEDB_CASE = "instance('casedb')/casedb/case";
const CURRENT_CASE_ID = "instance('commcaresession')/session/data/case_id";

/** A casedb `<case>` selected by its `@case_id`. */
function caseById(idExpr: string): string {
	return `${CASEDB_CASE}[@case_id = ${idExpr}]`;
}

/**
 * Expand a `#case/...` hashtag's segments to full casedb XPath, resolving
 * any leading relationship segments (`parent`, `grandparent`) through the
 * case index. Zero relationship segments → the plain case-loading shape,
 * byte-identical to the historical flat-prefix expansion. N hops → N nested
 * `caseById(...)/index/parent` walks from the current case to the target
 * case, then the remaining property path read off that case.
 */
function expandCaseHashtag(segments: string[]): string {
	let hops = 0;
	let firstProp = 0;
	while (firstProp < segments.length) {
		const segmentHops = CASE_RELATIONSHIP_HOPS.get(segments[firstProp]);
		if (segmentHops === undefined) break;
		hops += segmentHops;
		firstProp++;
	}
	const propPath = segments.slice(firstProp).join("/");

	if (hops === 0) {
		return VELLUM_HASHTAG_TRANSFORMS.prefixes["#case/"] + propPath;
	}

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
