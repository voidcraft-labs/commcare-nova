import {
	acceptsType,
	type CheckError,
	checkExpression,
	checkValueExpression,
	describe,
	type SlotConstraint,
	type TypeContext,
	type ValueExpression,
} from "@/lib/domain/predicate";

/** Actual editor projection: checker findings plus the mounting root slot. */
export function expressionEditorErrors(
	value: ValueExpression,
	typeCtx: TypeContext,
	constraint: SlotConstraint,
): readonly CheckError[] {
	const result = checkValueExpression(value, typeCtx);
	const collected: CheckError[] = result.ok ? [] : [...result.errors];
	if (constraint.accepts !== "any") {
		const resolved = checkExpression(value, typeCtx, [], []);
		if (resolved !== undefined && !acceptsType(constraint, resolved)) {
			collected.push({
				path: [],
				code: "constraint-value",
				message: `This value works out to ${describe(resolved)}, which doesn't fit this spot`,
			});
		}
	}
	return collected;
}
