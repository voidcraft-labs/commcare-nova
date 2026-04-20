/**
 * **dateArithmetic** — wraps date-producing arithmetic in `date()`.
 *
 * Nova's evaluator preserves date types through addition and
 * subtraction (`today() + 7` → XPathDate). CommCare's XPath 1.0
 * runtime does not — the same expression produces a raw day-number.
 * This pass bridges the gap by wrapping date-typed arithmetic
 * expressions in `date()` so CommCare interprets the number as a date.
 *
 * ## What it transforms
 *
 * | Input                        | Output                           |
 * |------------------------------|----------------------------------|
 * | `today() + 1`                | `date(today() + 1)`              |
 * | `today() - 7`                | `date(today() - 7)`              |
 * | `date('2024-01-01') + 30`    | `date(date('2024-01-01') + 30)`  |
 * | `date(today() + 1)`          | `date(today() + 1)` (no change)  |
 * | `today() + 1 > today()`      | `date(today() + 1) > today()`    |
 * | `date('2024-06-15') - date('2024-01-01')` | unchanged (date - date = number) |
 *
 * ## What it skips
 *
 * - Arithmetic that doesn't involve dates (pure numeric)
 * - Date subtraction (date - date → number, no wrapping needed)
 * - Expressions already inside a `date()` call
 */

import type { Tree } from "@lezer/common";
import { parser } from "../parser";
import type { SourceEdit } from "../transpiler";
import type { TypeMap } from "../typeInfer";

// ── Node type lookup ────────────────────────────────────────────────

const T = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((t) => t.name === name);
		if (!found) throw new Error(`Unknown node type: ${name}`);
		return found;
	};
	return {
		AddExpr: one("AddExpr"),
		SubtractExpr: one("SubtractExpr"),
	};
})();

// ── Pass implementation ─────────────────────────────────────────────

export function dateArithmetic(
	tree: Tree,
	types: TypeMap,
	source: string,
): SourceEdit[] {
	const edits: SourceEdit[] = [];

	/*
	 * Track ancestor context during traversal so we can detect
	 * "already inside date()" without relying on SyntaxNode.parent
	 * (which can be unreliable in Lezer's flat buffer trees).
	 */
	const ancestorStack: { name: string; from: number; to: number }[] = [];

	tree.iterate({
		enter(cursor) {
			ancestorStack.push({
				name: cursor.type.name,
				from: cursor.from,
				to: cursor.to,
			});

			const nodeType = cursor.type;

			/* Only interested in add/subtract expressions */
			if (nodeType !== T.AddExpr && nodeType !== T.SubtractExpr) return;

			/* Check if the type inference says this expression produces a date */
			const inferredType = types.get(cursor.node);
			if (inferredType !== "date") return;

			/* Skip if already wrapped in date() — check the ancestor stack */
			if (isInsideDateCall(ancestorStack, source)) return;

			/* Wrap: insert `date(` before and `)` after */
			edits.push(
				{ from: cursor.from, to: cursor.from, replacement: "date(" },
				{ from: cursor.to, to: cursor.to, replacement: ")" },
			);
		},

		leave() {
			ancestorStack.pop();
		},
	});

	return edits;
}

// ── Helpers ─────────────────────────────────────────────────────────

interface AncestorEntry {
	name: string;
	from: number;
	to: number;
}

/**
 * Check if the current node (top of the stack) is the direct argument
 * of a `date()` call by inspecting the ancestor stack.
 *
 * The expected stack shape when inside `date(expr)` is:
 *   ... → Invoke → ArgumentList → **current node**
 *
 * We verify that the Invoke's FunctionName is "date" by checking the
 * source text at the Invoke's position.
 */
function isInsideDateCall(stack: AncestorEntry[], source: string): boolean {
	const depth = stack.length;
	if (depth < 3) return false;

	/* Parent should be ArgumentList, grandparent should be Invoke */
	const parent = stack[depth - 2];
	if (parent.name !== "ArgumentList") return false;

	const grandparent = stack[depth - 3];
	if (grandparent.name !== "Invoke") return false;

	/*
	 * Check that the function name is "date". The Invoke node starts
	 * with the FunctionName text, so we can read from its start offset
	 * up to the opening paren.
	 */
	const invokeText = source.slice(grandparent.from, grandparent.to);
	return invokeText.startsWith("date(");
}
