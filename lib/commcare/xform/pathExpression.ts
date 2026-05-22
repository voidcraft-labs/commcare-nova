/**
 * Lezer-backed classification of XPath expressions against the two
 * parse-time gates CommCare Core / JavaRosa applies to attribute values.
 *
 * ## The two gates
 *
 * JavaRosa parses every XForm attribute that holds an expression and rejects
 * the form at parse time when the expression doesn't fit the surface's
 * contract. There are exactly two contracts:
 *
 *   - **PATH-only** — the value must be a *location path*. JavaRosa wraps the
 *     value in `new XPathReference(String)`, whose constructor calls
 *     `getPathExpr` and throws `XPathTypeMismatchException` when the parsed
 *     result is not an `XPathPathExpr`
 *     (`commcare-core/.../org/javarosa/model/xform/XPathReference.java::
 *     getPathExpr`). Surfaces: bind `nodeset`, control `ref`, `<repeat
 *     nodeset>`, `<group ref>`, `jr:count`, `<setvalue ref>`.
 *   - **ANY-expression** — the value need only parse as a valid XPath
 *     expression of any kind. JavaRosa builds it through `XPathParseTool`
 *     and surfaces a parse error if it can't (`buildCondition`,
 *     `buildCalculate`, `parseOutput`, `parseSetValueAction`'s `value`).
 *     Surfaces: bind `relevant`/`required`/`constraint`/`calculate`,
 *     `<output value>`, `<setvalue value>`.
 *
 * Both gates are *structural* properties of the parsed AST, not textual ones —
 * `count(/data/x)` contains a path substring but is a function call, and
 * `instance('casedb')/.../@id` contains a function call but IS a path. The
 * only faithful way to classify is the same Lezer grammar Nova ships for every
 * other XPath decision; this mirrors JavaRosa's own `instanceof XPathPathExpr`
 * AST check.
 *
 * ## What counts as path-shaped
 *
 * The allowlist mirrors JavaRosa's `ASTNodeLocPath.build`
 * (`commcare-core/.../org/javarosa/xpath/parser/ast/ASTNodeLocPath.java`): a
 * location path is any expression whose top-level structure is a path step or
 * a path separator. In the Lezer grammar
 * (`lib/commcare/xpath/grammar.lezer.grammar`):
 *
 *   - `Child` / `Descendant` — a `/` or `//` separated path.
 *   - `RootPath` — the bare `/` document root.
 *   - `NameTest` / `AttrSpecified` / `AxisSpecified` / `SelfStep` /
 *     `ParentStep` — a single relative step (`x`, `@id`, `child::x`, `.`,
 *     `..`).
 *   - `Filtered` (`base[predicate]`) — path-shaped IFF its base (the
 *     `Filtered` node's first child) is itself path-shaped. `/data/items[1]`
 *     has a `Child` base → path; `count(/data/x)[1]` has an `Invoke` base and
 *     `(/data/x)[1]` has a `(`-token base → both non-path. JavaRosa likewise
 *     builds an `XPathFilterExpr`, which `getPathExpr` rejects, for these.
 *
 * Everything else is non-path: `NumberLiteral`, `StringLiteral`, `Invoke`,
 * the arithmetic / relational / logical `*Expr` nodes, `UnionExpr`,
 * `VariableReference`. A bare parenthesized `(expr)` is the one case the
 * node-membership test never sees directly: the grammar surfaces `(` and `)`
 * as their own sibling tokens, so `(/data/x)` parses to three top-level
 * children (`(`, the inner `Child`, `)`) and fails the "exactly one top-level
 * child" guard. JavaRosa rejects it too — a parenthesized expression with no
 * trailing path separator builds an `XPathFilterExpr`, not an `XPathPathExpr`.
 *
 * `HashtagRef` is deliberately absent from the path allowlist: every caller
 * runs `expandHashtags` BEFORE classifying, so `#form/x` has already become
 * `/data/x` (a `Child`) by the time this code sees it. Listing a node that
 * can never appear would be dead defense.
 */

import type { SyntaxNode, Tree } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";

/**
 * Lezer node-type lookup, built once from the parser's node set so a grammar
 * change that renames or drops one of these nodes fails at module load instead
 * of silently misclassifying. Mirrors the `T = (() => {...})()` pattern in
 * `lib/commcare/xpath/typeInfer.ts`.
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
				`The XPath path classifier expects a grammar node named "${name}", but the parser's node set doesn't have one. The Lezer grammar at lib/commcare/xpath/grammar.lezer.grammar was changed without updating this classifier — re-derive the path-node allowlist against the current grammar.`,
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
 * Parse `expr` and return its tree only when the parse is error-free — a
 * recovered tree can present a path-shaped top node next to an error node,
 * which would misclassify both gates below. Returns `null` on any parse error
 * (or on empty input, which is never a valid expression).
 */
function parseCleanTree(expr: string): Tree | null {
	const trimmed = expr.trim();
	if (!trimmed) return null;

	const tree = parser.parse(trimmed);
	let hasError = false;
	tree.iterate({
		enter(node) {
			if (node.type.isError) hasError = true;
		},
	});
	return hasError ? null : tree;
}

/**
 * Returns `true` when `expr` is a location path that JavaRosa accepts through
 * `XPathReference.getPathExpr` — the PATH-only gate. A parse error returns
 * `false`: an unparseable value is never a valid path, and for callers that
 * hoist (the `jr:count` emitter) a false-negative merely adds an extra hidden
 * node, whereas a false-positive emits markup JavaRosa rejects.
 *
 * `expr` must be ALREADY hashtag-expanded (callers run `expandHashtags`
 * first) — `HashtagRef` is intentionally not in the path allowlist.
 */
export function isPathExpression(expr: string): boolean {
	const tree = parseCleanTree(expr);
	if (!tree) return false;

	// Require exactly one top-level node under the `XPath` root. More than one
	// child is non-path: a bare parenthesized expression surfaces `(` + inner +
	// `)` as three siblings, and JavaRosa rejects such a value through
	// `getPathExpr` (it builds an `XPathFilterExpr`, not an `XPathPathExpr`).
	const top = tree.topNode.firstChild;
	if (!top || top.nextSibling) return false;

	return isPathNode(top);
}

/**
 * Returns `true` when `expr` parses as a valid XPath expression of any kind —
 * the ANY-expression gate. Mirrors JavaRosa surfacing a parse error from
 * `XPathParseTool` for `relevant`/`constraint`/`calculate`, `<output value>`,
 * and `<setvalue value>`. Empty input is invalid (those surfaces require an
 * expression to be present when the attribute is).
 *
 * `expr` must be ALREADY hashtag-expanded; a raw `#case/x` is not valid XPath
 * to the grammar and would false-reject.
 */
export function isParseableXPath(expr: string): boolean {
	return parseCleanTree(expr) !== null;
}
