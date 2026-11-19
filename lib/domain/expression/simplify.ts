import {
	and,
	isMatchAll,
	isMatchNone,
	matchAll,
	matchNone,
	not,
	or,
} from "./builders";
import { literalInstantText } from "./instantOperand";
import { mapExpressionAst } from "./mapAst";
import type { Expression } from "./types";
/** Record emission's boolean simplifier. Authored trees remain untouched. */
export function simplifyForEmission(expression: Expression): Expression {
	return mapExpressionAst(expression, {
		mapExpression: (node) => {
			switch (node.kind) {
				case "and":
					return simplifyLogical(node.clauses, "and");
				case "or":
					return simplifyLogical(node.clauses, "or");
				case "not":
					return not(simplifyForEmission(node.clause));
				case "is-blank": {
					if (node.left.kind === "term" && node.left.term.kind === "literal")
						return node.left.term.value === null || node.left.term.value === ""
							? matchAll()
							: matchNone();
					// A negated number is a number, never blank.
					let negated: Expression = node.left;
					while (negated.kind === "negate") negated = negated.value;
					if (
						negated !== node.left &&
						negated.kind === "term" &&
						negated.term.kind === "literal" &&
						typeof negated.term.value === "number"
					)
						return matchNone();
					// A date and time made of a literal that names a moment is that
					// moment's text (`instantOperand.ts::literalInstantText`).
					const coerced =
						node.left.kind === "datetime-coerce" ? node.left.value : undefined;
					if (
						coerced?.kind === "term" &&
						coerced.term.kind === "literal" &&
						typeof coerced.term.value === "string" &&
						literalInstantText(coerced.term.value) !== undefined
					)
						return matchNone();
					return undefined;
				}
				default:
					return undefined;
			}
		},
	});
}
function simplifyLogical(
	clauses: readonly Expression[],
	kind: "and" | "or",
): Expression {
	const kept: Expression[] = [];
	for (const clause of clauses) {
		const simple = simplifyForEmission(clause);
		if (kind === "and" ? isMatchNone(simple) : isMatchAll(simple))
			return kind === "and" ? matchNone() : matchAll();
		if (kind === "and" ? isMatchAll(simple) : isMatchNone(simple)) continue;
		if (simple.kind === kind) kept.push(...simple.clauses);
		else kept.push(simple);
	}
	if (kept.length === 0) return kind === "and" ? matchAll() : matchNone();
	if (kept.length === 1) return kind === "and" ? and(kept[0]) : or(kept[0]);
	return kind === "and"
		? and(kept[0], kept[1], ...kept.slice(2))
		: or(kept[0], kept[1], ...kept.slice(2));
}
export function effectiveFilterForEmission(
	filter: Expression | undefined,
): Expression | undefined {
	if (filter === undefined) return undefined;
	const simplified = simplifyForEmission(filter);
	return isMatchAll(simplified) ? undefined : simplified;
}
export function displayConditionForEmission(
	condition: Expression | undefined,
): Expression | undefined {
	return condition === undefined || isMatchAll(condition)
		? undefined
		: condition;
}
export function displayConditionStartsWithNever(
	condition: Expression | undefined,
): boolean {
	return (
		condition?.kind === "match-none" ||
		(condition?.kind === "and" && condition.clauses[0].kind === "match-none")
	);
}
