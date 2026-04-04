/**
 * Vellum hashtag expansion — converts #form/, #case/, and #user/ shorthand to full XPath.
 *
 * Uses the Lezer XPath parser to identify HashtagRef nodes and their structured
 * children (HashtagType, HashtagSegment), then surgically replaces them with
 * expanded XPath. The shorthand is preserved in vellum:* attributes for
 * round-tripping back to the editor.
 */
import { parser } from "@/lib/codemirror/xpath-parser";

// Pre-resolve node types — zero string comparisons at runtime
const T = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => all.find((t) => t.name === name)!;
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
 * Expansion prefix by hashtag type.
 * #form/ is a trivial /data/ expansion (not in HQ transforms, hardcoded in Vellum).
 * #case/ and #user/ expand to full instance() XPath.
 */
const EXPANSIONS = new Map<string, string>([
	["form", "/data/"],
	["case", VELLUM_HASHTAG_TRANSFORMS.prefixes["#case/"]],
	["user", VELLUM_HASHTAG_TRANSFORMS.prefixes["#user/"]],
]);

/** Hashtag types that need HQ-side vellum:hashtags metadata (non-trivial expansions). */
const HQ_HASHTAG_TYPES = new Set(["case", "user"]);

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
				const type = ref.getChild(T.HashtagType.id)!;
				const segments = ref.getChildren(T.HashtagSegment.id);
				const typeName = expr.slice(type.from, type.to);
				const path = segments.map((s) => expr.slice(s.from, s.to)).join("/");
				const prefix = EXPANSIONS.get(typeName);
				if (prefix) {
					edits.push({ from: node.from, to: node.to, text: prefix + path });
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
					const type = node.node.getChild(T.HashtagType.id)!;
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
