import { type Expression, isConditionArm } from "./types";

/** Logical construction keeps scalar operands boolean without changing their coercion. */
function booleanExpression(value: Expression): Expression {
	return isConditionArm(value)
		? value
		: { kind: "not", clause: { kind: "not", clause: value } };
}
export function reduceAnd(
	clauses: readonly Expression[],
): Expression | undefined {
	if (clauses.length === 0) return { kind: "match-all" };
	if (clauses.length === 1) return booleanExpression(clauses[0]);
	return undefined;
}
export function reduceOr(
	clauses: readonly Expression[],
): Expression | undefined {
	if (clauses.length === 0) return { kind: "match-none" };
	if (clauses.length === 1) return booleanExpression(clauses[0]);
	return undefined;
}
export function reduceNot(clause: Expression): Expression | undefined {
	if (clause.kind === "match-all") return { kind: "match-none" };
	if (clause.kind === "match-none") return { kind: "match-all" };
	if (clause.kind === "not" && isConditionArm(clause.clause))
		return clause.clause;
	return undefined;
}
