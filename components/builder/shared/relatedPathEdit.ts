import {
	predicateExpressionRuntimeEditVerdict,
	valueExpressionRuntimeEditVerdict,
} from "@/lib/doc/hooks/predicateVerdicts";
import {
	checkPredicate,
	checkValueExpression,
	type Predicate,
	type RelationPath,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { presentCheckErrorForEditor } from "./checkErrorPresentation";
import { buildEditorTypeContext } from "./editorTypeContext";
import type { ExpressionEditContext } from "./expressionEditorSchemas";

type RelatedValue =
	| Extract<Predicate, { kind: "exists" | "missing" }>
	| Extract<ValueExpression, { kind: "count" }>;

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
	const typeContext = buildEditorTypeContext(ctx);
	const checked =
		candidate.kind === "count"
			? checkValueExpression(candidate, typeContext)
			: checkPredicate(candidate, typeContext);
	if (!checked.ok)
		return {
			admitted: false as const,
			reason: presentCheckErrorForEditor(checked.errors[0]),
		};
	const runtime =
		candidate.kind === "count"
			? valueExpressionRuntimeEditVerdict(
					candidate,
					ctx.evaluationTarget ?? "on-device",
					typeContext,
				)
			: predicateExpressionRuntimeEditVerdict(
					candidate,
					ctx.evaluationTarget ?? "on-device",
					typeContext,
				);
	return runtime.ok
		? { admitted: true as const }
		: { admitted: false as const, reason: runtime.reason };
}
