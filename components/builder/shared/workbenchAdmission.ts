import {
	type ExpressionEvaluationTarget,
	predicateExpressionRuntimeEditVerdict,
} from "@/lib/doc/hooks/predicateVerdicts";
import type {
	Predicate,
	TypeContext,
	ValueExpression,
} from "@/lib/domain/predicate";
import type { EditorPath } from "./path";
import { replaceRuleNodeAtPath } from "./ruleNavigation";

/** Checks the complete containing rule after a proposed nested expression edit.
 * A local slot can accept a value that its runtime or parent cannot execute. */
export function workbenchExpressionAdmission(
	value: Predicate,
	path: EditorPath,
	next: ValueExpression,
	evaluationTarget: ExpressionEvaluationTarget,
	typeContext: TypeContext,
) {
	const candidate = replaceRuleNodeAtPath(value, path, {
		family: "expression",
		value: next,
	});
	const verdict = predicateExpressionRuntimeEditVerdict(
		candidate,
		evaluationTarget,
		typeContext,
	);
	return verdict.ok
		? { admitted: true as const }
		: { admitted: false as const, reason: verdict.reason };
}
