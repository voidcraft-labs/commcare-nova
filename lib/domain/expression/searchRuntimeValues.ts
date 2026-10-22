/**
 * The values of a server search condition that a device works out before the
 * search runs: its `runtime` subtrees (`csqlPositions.ts`). The server's
 * search language evaluates a closed set of values itself, a read and HQ's
 * value functions (`now`, `date-coerce`, `datetime-coerce`, `double`,
 * `date-add` and `unwrap-list`, CommCare HQ's
 * `corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`).
 * Any other value (an `if`, `coalesce`, `switch`, arithmetic, `concat`,
 * `format-date`, `today`, …), a condition that chooses between clauses, and a
 * clause that reads no case row are evaluated by Core on the device and their
 * answers spliced into the query (`lib/commcare/csql/emitter.ts`, its runtime
 * holes). `today` is one of them: CommCare's search reads the worker's day,
 * which only the device knows (part 06 decision 6).
 *
 * The emitter, the CSQL validators and the checker all read these values here,
 * so none of them evaluates on a device what another sends to the server.
 */
import type { ExpressionContext } from "./context";
import {
	type CsqlPosition,
	csqlRuntimeRoots,
	isCsqlServerValueFunction,
} from "./csqlPositions";
import { expressionContextAtPath } from "./typeChecker";
import { type CheckPath, type Expression, isExpression } from "./types";

/** A value the server's search language evaluates itself, its operands
 * evaluated the same way in turn: a read, or one of HQ's value functions. */
export function isServerSearchValue(expression: Expression): boolean {
	return expression.kind === "term" || isCsqlServerValueFunction(expression);
}

type Visit = (
	value: Expression,
	context: ExpressionContext,
	path: CheckPath,
	/** Where the subtree sits: `query` for a whole clause or the condition of
	 * a choice between clauses, `server-value` or `raw` for a value. */
	within: Exclude<CsqlPosition, "runtime">,
) => void;

/**
 * Visit each subtree of a server search condition that a device evaluates,
 * with its lexical context and its path from `predicate`.
 */
export function walkSearchRuntimeValues(
	predicate: Expression,
	context: ExpressionContext,
	visit: Visit,
): void {
	for (const root of csqlRuntimeRoots(predicate)) {
		const value: Expression = isExpression(root.node)
			? root.node
			: { kind: "term", term: root.node };
		visit(
			value,
			expressionContextAtPath(predicate, context, root.path),
			root.path,
			root.within,
		);
	}
}
