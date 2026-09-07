import type { CaseType } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { resolveRelationDestination } from "./relationDestination";
/** Display context for typed membership literals; values belong to the
 * subject's resolved property, which can be on a connected case. */
export function membershipLiteralContext(
	value: Extract<Predicate, { kind: "in" }>,
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
				? ref.caseType
				: (resolveRelationDestination(ref.via, ref.caseType, caseTypes) ?? "");
	return { caseTypeName, propertyName: ref?.property };
}
