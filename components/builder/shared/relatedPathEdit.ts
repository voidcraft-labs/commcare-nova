import { expressionEditVerdict } from "@/lib/doc/hooks/predicateVerdicts";
import {
	checkExpression,
	type ExpressionOfKind,
	type PropertyRef,
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

/** A property read over another relation. A reached read (whatever case
 *  each link names, of any type) stays one while the relation still walks
 *  up links; any other relation reads a typed case, so the read becomes the
 *  ordinary one. */
export function replacePropertyRelation(
	value: PropertyRef,
	via: RelationPath,
): PropertyRef {
	const { readReached, ...typed } = value;
	return readReached === true && via.kind === "ancestor"
		? { ...typed, via, readReached }
		: { ...typed, via };
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
