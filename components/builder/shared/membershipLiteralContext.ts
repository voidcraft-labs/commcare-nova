import type { CaseType } from "@/lib/domain";
import type { ExpressionOfKind } from "@/lib/domain/expression";
import { resolveRelationDestination } from "./relationDestination";
/** Display context for typed membership literals; values belong to the
 * subject's resolved property, which can be on a connected case. */
export function membershipLiteralContext(
	value: ExpressionOfKind<"in">,
	currentCaseType: string,
	caseTypes: readonly CaseType[],
) {
	const ref =
		value.left.kind === "term" && value.left.term.kind === "prop"
			? value.left.term
			: undefined;
	const caseTypeName =
		ref === undefined
			? currentCaseType
			: ref.via === undefined
				? (ref.caseType ?? currentCaseType)
				: (resolveRelationDestination(
						ref.via,
						ref.caseType ?? currentCaseType,
						caseTypes,
					) ?? "");
	return { caseTypeName, propertyName: ref?.property };
}
