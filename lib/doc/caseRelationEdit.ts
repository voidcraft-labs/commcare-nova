import type { CaseType } from "@/lib/domain/blueprint";
import {
	type CaseRelation,
	compareCaseRelations,
	declaredCaseRelations,
} from "@/lib/domain/caseRelations";
import type { Mutation } from "./types";

/** A named link edit names one edge even when two people edit the same index.
 * The default parent has an older compact storage spelling: a lone `parent`
 * link with a kind sits in that slot, so every reader of `parent_type`
 * (parent selection, exports, the case store) sees it, as
 * `caseRelations.ts::relationMetadata` spells a lone parent. A link added to
 * a type with no parent link yet takes the slot, and a removal that leaves
 * one parent link stored under `relations` moves that link into it. */
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
	if (action === "remove") return removeCaseRelations(type, [edge]);
	if (
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

/** Remove each of `edges` the type declares, as stored (a link with no kind
 * matches only itself), then move a lone surviving parent link with a kind
 * from `relations` into the default slot. */
export function removeCaseRelations(
	type: CaseType,
	edges: readonly CaseRelation[],
): Mutation[] {
	const declared = declaredCaseRelations(type);
	const removed = edges.filter((edge) =>
		declared.some((current) => compareCaseRelations(current, edge) === 0),
	);
	if (removed.length === 0) return [];
	const out: Mutation[] = removed.map((edge) => ({
		kind: "setCaseTypeMeta",
		caseType: type.name,
		relationChange: { action: "remove", edge },
	}));
	const keepsDefault =
		type.parent_type !== undefined &&
		!removed.some(
			(edge) =>
				edge.identifier === "parent" &&
				edge.targetType === type.parent_type &&
				edge.relationship === (type.relationship ?? "child"),
		);
	const parents = declared.filter(
		(current) =>
			current.identifier === "parent" &&
			!removed.some((edge) => compareCaseRelations(current, edge) === 0),
	);
	const survivor = parents.length === 1 ? parents[0] : undefined;
	if (!keepsDefault && survivor?.relationship !== undefined)
		out.push(
			{
				kind: "setCaseTypeMeta",
				caseType: type.name,
				relationChange: { action: "remove", edge: survivor },
			},
			{
				kind: "setCaseTypeMeta",
				caseType: type.name,
				parent_type: survivor.targetType,
				relationship: survivor.relationship,
			},
		);
	return out;
}

/** Make `edge` the type's default parent, replacing the current default and
 * taking it out of `relations` where it is stored there; or, for `null`,
 * clear the default as a removal of its link. Empty when nothing changes. */
export function setDefaultCaseParent(
	type: CaseType,
	edge:
		| (CaseRelation & { readonly relationship: "child" | "extension" })
		| null,
): Mutation[] {
	if (edge === null)
		return type.parent_type === undefined
			? []
			: removeCaseRelations(type, [
					{
						identifier: "parent",
						targetType: type.parent_type,
						relationship: type.relationship ?? "child",
					},
				]);
	if (
		type.parent_type === edge.targetType &&
		(type.relationship ?? "child") === edge.relationship
	)
		return [];
	const stored = (type.relations ?? []).some(
		(current) => compareCaseRelations(current, edge) === 0,
	);
	return [
		...(stored
			? [
					{
						kind: "setCaseTypeMeta" as const,
						caseType: type.name,
						relationChange: { action: "remove" as const, edge },
					},
				]
			: []),
		{
			kind: "setCaseTypeMeta",
			caseType: type.name,
			parent_type: edge.targetType,
			relationship: edge.relationship,
		},
	];
}
