import { expressionEditVerdict } from "@/lib/doc/hooks/predicateVerdicts";
import {
	checkExpression,
	type ExpressionOfKind,
	type RelationPath,
} from "@/lib/domain/expression";
import { presentCheckErrorForEditor } from "./checkErrorPresentation";
import type { ExpressionEditContext } from "./expressionEditorSchemas";

type RelatedValue = ExpressionOfKind<"exists" | "missing" | "count">;

/** Changing a connection preserves its authored filter as one candidate. */
export function replaceRelatedPath<T extends RelatedValue>(
	value: T,
	via: RelationPath,
): T {
	return { ...value, via };
}

/** The complete retained filter must remain valid in the new destination. */
export function relatedPathEditAdmission(
	value: RelatedValue,
	via: RelationPath,
	ctx: ExpressionEditContext,
) {
	const candidate = replaceRelatedPath(value, via);
	const checked = checkExpression(candidate, ctx.expressionContext);
	if (checked.errors.length > 0)
		return {
			admitted: false as const,
			reason: presentCheckErrorForEditor(checked.errors[0]),
		};
	const runtime = expressionEditVerdict(candidate, ctx.expressionContext);
	return runtime.ok
		? { admitted: true as const }
		: { admitted: false as const, reason: runtime.reason };
}
