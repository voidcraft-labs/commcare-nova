import type { CaseType } from "@/lib/domain/blueprint";
import {
	type CaseRelation,
	compareCaseRelations,
	declaredCaseRelations,
} from "@/lib/domain/caseRelations";
import type { Mutation } from "./types";

/** A named link edit names one edge even when two people edit the same index.
 * The default parent has an older compact storage spelling. */
export function editCaseRelation(
	type: CaseType,
	action: "add" | "remove",
	edge: CaseRelation,
): Mutation[] {
	const present = declaredCaseRelations(type).some(
		(current) => compareCaseRelations(current, edge) === 0,
	);
	if (present === (action === "add")) return [];
	return [
		{
			kind: "setCaseTypeMeta",
			caseType: type.name,
			relationChange: { action, edge },
		},
	];
}
