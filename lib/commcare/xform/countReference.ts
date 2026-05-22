/**
 * Classifies a `count_bound` repeat's count expression as either a
 * location-path reference or a non-path value, to decide how the XForm
 * emitter wires `jr:count`.
 *
 * ## Why this exists
 *
 * JavaRosa parses the `jr:count` attribute value through
 * `XPathReference(String)`, whose constructor calls `getPathExpr` and
 * throws `XPathTypeMismatchException("Expected XPath path, got XPath
 * expression: [...]")` when the parsed result is NOT an `XPathPathExpr`
 * (`commcare-core/.../org/javarosa/model/xform/XPathReference.java::
 * getPathExpr`, reached from `commcare-core/.../org/javarosa/xform/parse/
 * XFormParser.java::parseGroup`, which wraps the `jr:count` attribute in
 * `new XPathReference(countRef)`). So `jr:count` MUST be a node reference —
 * a literal (`3`), arithmetic (`3 + 2`), or function call (`count(...)`) on
 * that attribute is a hard parse failure on upload.
 *
 * The emitter therefore hoists any non-path count into a hidden data node
 * seeded by an `xforms-ready` `<setvalue>` and points `jr:count` at that
 * node — `<count_node/>` + `<setvalue ref=".../count_node" value="<expr>"/>`
 * + `jr:count=".../count_node"`. A count that is already a path points
 * `jr:count` straight at it, no hoist. Both shapes are what JavaRosa's
 * repeat-count parsing accepts through `XPathReference(String)`
 * (`commcare-core .../model/xform/XPathReference.java::getPathExpr`).
 *
 * ## Why a parser, not a regex
 *
 * Whether an expression is path-shaped is a structural property of the
 * parsed AST, not a textual one — `count(/data/x)` contains a path
 * substring but is a function call, while `instance('casedb')/.../@id`
 * contains a function call but IS a path. Classifying with the same Lezer
 * grammar Nova ships for every other XPath decision is the only way to get
 * this right, and it mirrors JavaRosa's own `instanceof XPathPathExpr`
 * runtime check at the AST level.
 *
 * ## What counts as path-shaped
 *
 * The allowlist mirrors JavaRosa's `ASTNodeLocPath.build`
 * (`commcare-core/.../org/javarosa/xpath/parser/ast/ASTNodeLocPath.java`):
 * a location path is any expression whose top-level structure is a path
 * step or a path separator. In the Lezer grammar
 * (`lib/commcare/xpath/grammar.lezer.grammar`) that maps to:
 *
 *   - `Child` / `Descendant` — a `/` or `//` separated path.
 *   - `RootPath` — the bare `/` document root.
 *   - `NameTest` / `AttrSpecified` / `AxisSpecified` / `SelfStep` /
 *     `ParentStep` — a single relative step (`x`, `@id`, `child::x`, `.`,
 *     `..`).
 *   - `Filtered` (`base[predicate]`) — path-shaped IFF its base (the
 *     `Filtered` node's first child) is itself path-shaped. `/data/items[1]`
 *     has a `Child` base → path; `count(/data/x)[1]` has an `Invoke` base and
 *     `(/data/x)[1]` has a `(`-token base → both non-path. We recurse on the
 *     base to decide. (JavaRosa likewise builds an `XPathFilterExpr`, which
 *     `getPathExpr` rejects, for these.)
 *
 * Everything else is non-path and must be hoisted. Most are a single
 * top-level node `isPathNode` rejects directly: `NumberLiteral`,
 * `StringLiteral`, `Invoke` (function call), the arithmetic / relational /
 * logical `*Expr` nodes, `UnionExpr`, `VariableReference`. A bare
 * parenthesized `(expr)` is the one case `isPathNode` never sees: the Lezer
 * grammar surfaces the `(` and `)` as their own sibling tokens, so
 * `(/data/x)` parses to three top-level children (`(`, the inner `Child`,
 * `)`) and `isCountReferencePath` rejects it on the "exactly one top-level
 * child" guard below. JavaRosa rejects it too — a parenthesized expression
 * with no trailing path separator builds an `XPathFilterExpr`, not an
 * `XPathPathExpr`, so `getPathExpr` throws — making hoist the matching call.
 *
 * `HashtagRef` is deliberately absent from the allowlist: the emitter runs
 * `expandHashtags` BEFORE classifying, so `#form/x` has already become
 * `/data/x` (a `Child`) by the time this code sees it. Listing a node that
 * can never appear would be dead defense.
 */

import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";

/**
 * Lezer node-type lookup, built once from the parser's node set so a
 * grammar change that renames or drops one of these nodes fails at module
 * load instead of silently misclassifying. Mirrors the `T = (() => {...})()`
 * pattern in `lib/commcare/xpath/typeInfer.ts`.
 */
const NODE = (() => {
	const all = parser.nodeSet.types;
	// A grammar rule name can map to MORE THAN ONE node id — `Child` and
	// `Descendant` each appear twice in the grammar (the leading-slash
	// `rootStep` form and the binary `expr` form), so the parser's node set
	// carries two distinct ids per name. Collect every id per name (mirrors
	// `typeInfer.ts`'s `many(...)`); matching only the first id would
	// misclassify whichever form the parser actually emitted.
	const idsOf = (name: string): number[] => {
		const ids = all.filter((t) => t.name === name).map((t) => t.id);
		if (ids.length === 0) {
			throw new Error(
				`The XPath count-reference classifier expects a grammar node named "${name}", but the parser's node set doesn't have one. The Lezer grammar at lib/commcare/xpath/grammar.lezer.grammar was changed without updating this classifier — re-derive the path-node allowlist against the current grammar.`,
			);
		}
		return ids;
	};
	return {
		Filtered: new Set<number>(idsOf("Filtered")),
		// Top-level node ids that are themselves a location path.
		pathNodeIds: new Set<number>(
			[
				"Child",
				"Descendant",
				"RootPath",
				"NameTest",
				"AttrSpecified",
				"AxisSpecified",
				"SelfStep",
				"ParentStep",
			].flatMap(idsOf),
		),
	};
})();

/**
 * Decide whether one CST node is path-shaped. `Filtered` recurses onto its
 * filtered base (the first child expr); every other node is classified by
 * membership in the path-node id set.
 */
function isPathNode(node: SyntaxNode): boolean {
	if (NODE.Filtered.has(node.type.id)) {
		const base = node.firstChild;
		return base ? isPathNode(base) : false;
	}
	return NODE.pathNodeIds.has(node.type.id);
}

/**
 * Returns `true` when `expr` is a location path that JavaRosa accepts
 * directly as a `jr:count` reference, `false` when it must be hoisted into
 * a hidden node first.
 *
 * `expr` is the ALREADY-hashtag-expanded count string (the emitter calls
 * `expandHashtags` first). A parse error returns `false` — an unparseable
 * count is never a valid path, and hoisting is the safe direction (a
 * false-negative classification merely adds an extra hidden node; a
 * false-positive emits a `jr:count` JavaRosa rejects, which is the exact
 * bug this guards).
 */
export function isCountReferencePath(expr: string): boolean {
	const trimmed = expr.trim();
	if (!trimmed) return false;

	const tree = parser.parse(trimmed);

	// Reject any parse error anywhere — a recovered tree can present a
	// path-shaped top node next to an error, which would misclassify.
	let hasError = false;
	tree.iterate({
		enter(node) {
			if (node.type.isError) hasError = true;
		},
	});
	if (hasError) return false;

	// Require exactly one top-level node under the `XPath` root. More than
	// one child is non-path: a malformed parse, OR a bare parenthesized
	// expression — the grammar surfaces `(` and `)` as their own sibling
	// tokens, so `(/data/x)` lands here as `(` + `Child` + `)`, and JavaRosa
	// rejects such a `jr:count` (see the module comment).
	const top = tree.topNode.firstChild;
	if (!top || top.nextSibling) return false;

	return isPathNode(top);
}
