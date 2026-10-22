import {
	acceptsType,
	type CheckError,
	checkExpression,
	describe,
	type Expression,
	type ExpressionContext,
	type SlotConstraint,
	scalarDataType,
	typeOf,
} from "@/lib/domain/expression";

/** Actual editor projection: checker findings plus the mounting root slot. */
export function expressionEditorErrors(
	value: Expression,
	typeCtx: ExpressionContext,
	constraint: SlotConstraint,
): readonly CheckError[] {
	const collected: CheckError[] = [...checkExpression(value, typeCtx).errors];
	if (constraint.accepts !== "any") {
		const resolved = scalarDataType(typeOf(value, typeCtx)?.data);
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
