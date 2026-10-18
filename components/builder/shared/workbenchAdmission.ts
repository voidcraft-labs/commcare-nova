import { expressionEditVerdict } from "@/lib/doc/hooks/predicateVerdicts";
import type { Expression, ExpressionContext } from "@/lib/domain/expression";
import type { EditorPath } from "./path";
import { replaceRuleNodeAtPath } from "./ruleNavigation";

/** Checks the complete containing rule after a proposed nested expression edit.
 * A local slot can accept a value that its runtime or parent cannot execute. */
export function workbenchExpressionAdmission(
	value: Expression,
	path: EditorPath,
	next: Expression,
	expressionContext: ExpressionContext,
) {
	const candidate = replaceRuleNodeAtPath(value, path, {
		family: "expression",
		value: next,
	});
	const verdict = expressionEditVerdict(candidate, expressionContext);
	return verdict.ok
		? { admitted: true as const }
		: { admitted: false as const, reason: verdict.reason };
}
