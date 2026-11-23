import type { CaseType } from "@/lib/domain/blueprint";
import {
	type CaseRelation,
	compareCaseRelations,
	declaredCaseRelations,
} from "@/lib/domain/caseRelations";
import type { Mutation } from "./types";

/** A named link edit names one edge even when two people edit the same index.
 * The default parent has an older compact storage spelling: a `parent` link
 * added to a type with no parent link yet takes that slot, so every reader of
 * `parent_type` (parent selection, exports, the case store) sees it, as
 * `caseRelations.ts::relationMetadata` spells a lone parent. */
export function editCaseRelation(
	type: CaseType,
	action: "add" | "remove",
	edge: CaseRelation,
): Mutation[] {
	const declared = declaredCaseRelations(type);
	const present = declared.some(
		(current) => compareCaseRelations(current, edge) === 0,
	);
	if (present === (action === "add")) return [];
	if (
		action === "add" &&
		edge.identifier === "parent" &&
		edge.relationship !== undefined &&
		!declared.some((current) => current.identifier === "parent")
	)
		return [
			{
				kind: "setCaseTypeMeta",
				caseType: type.name,
				parent_type: edge.targetType,
				relationship: edge.relationship,
			},
		];
	return [
		{
			kind: "setCaseTypeMeta",
			caseType: type.name,
			relationChange: { action, edge },
		},
	];
}
