import { z } from "zod";
import type { CaseType } from "./blueprint";
import type { RelationStep } from "./expression/types";

/** A case index points from the case that owns it to the case it names. A
 * typed load can name the destination without observing the relationship kind. */
export const CASE_INDEX_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
export const caseIndexNameSchema = z.string().regex(CASE_INDEX_NAME_PATTERN);
/** A link a case list column can walk through: one word of CommCare HQ's
 * case list field grammar (`suite/wire.ts::HQ_FIELD_WORD`), a letter first
 * and then letters, digits, `_` and `-`. A case index name may also hold a
 * dot or start with an underscore; HQ keeps no such link on a column. */
export const CASE_LIST_LINK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const caseRelationSchema = z.strictObject({
	identifier: caseIndexNameSchema,
	targetType: z.string().regex(/^[A-Za-z0-9_-]+$/),
	relationship: z.enum(["child", "extension"]).optional(),
});
export type CaseRelation = z.infer<typeof caseRelationSchema>;

export function compareCaseRelations(
	left: CaseRelation,
	right: CaseRelation,
): number {
	for (const key of ["identifier", "targetType", "relationship"] as const) {
		const a = left[key] ?? "";
		const b = right[key] ?? "";
		if (a !== b) return a < b ? -1 : 1;
	}
	return 0;
}

export function declaredCaseRelations(
	type: Pick<CaseType, "parent_type" | "relationship" | "relations">,
): readonly CaseRelation[] {
	const extra = type.relations ?? [];
	if (type.parent_type === undefined) return extra;
	return [
		{
			identifier: "parent",
			targetType: type.parent_type,
			relationship: type.relationship ?? "child",
		},
		...extra,
	];
}

/** Index names are scoped to their owning case type. Several writers may
 * assign the same index to different types, or use a different kind. */
export class CaseRelationCatalog {
	private readonly origins = new Map<string, Map<string, CaseRelation[]>>();

	constructor(types: readonly CaseType[]) {
		for (const type of types)
			for (const edge of declaredCaseRelations(type))
				this.note(type.name, edge);
	}

	note(origin: string, edge: CaseRelation): void {
		let indices = this.origins.get(origin);
		if (indices === undefined) {
			indices = new Map();
			this.origins.set(origin, indices);
		}
		const existing = indices.get(edge.identifier) ?? [];
		const same = existing.filter((one) => one.targetType === edge.targetType);
		if (
			same.some((one) => one.relationship === edge.relationship) ||
			(edge.relationship === undefined && same.length > 0)
		)
			return;
		const next = existing.filter(
			(one) =>
				one.targetType !== edge.targetType || one.relationship !== undefined,
		);
		next.push(edge);
		indices.set(edge.identifier, next.sort(compareCaseRelations));
	}

	edges(origin: string, identifier?: string): readonly CaseRelation[] {
		const indices = this.origins.get(origin);
		if (indices === undefined) return [];
		if (identifier !== undefined) return indices.get(identifier) ?? [];
		return [...indices.values()].flat().sort(compareCaseRelations);
	}

	/** Native property columns follow IDs without a case type predicate. An
	 * unknown hop can reach a type outside the application's declarations. */
	reached(
		origin: string,
		steps: readonly RelationStep[],
	): {
		readonly types: readonly string[];
		readonly open: boolean;
	} {
		let current = new Set([origin]);
		let open = false;
		for (const step of steps) {
			const next = new Set<string>();
			for (const type of current) {
				const edges = this.edges(type, step.identifier);
				if (edges.length === 0) {
					if (step.throughCaseType !== undefined)
						next.add(step.throughCaseType);
					else open = true;
				}
				for (const edge of edges) next.add(edge.targetType);
			}
			current = next;
		}
		return { types: [...current].sort(), open };
	}
}

/** The historical parent slot remains the compact encoding of a unique
 * default. Its absence on an old document conveys no historic case-row fact. */
export function relationMetadata(
	edges: readonly CaseRelation[],
): Pick<CaseType, "parent_type" | "relationship" | "relations"> {
	const parents = edges.filter((edge) => edge.identifier === "parent");
	const single =
		parents.length === 1 && parents[0].relationship !== undefined
			? parents[0]
			: undefined;
	const rest = edges.filter((edge) => edge !== single);
	return {
		...(single !== undefined && {
			parent_type: single.targetType,
			...(single.relationship !== undefined && {
				relationship: single.relationship,
			}),
		}),
		...(rest.length > 0 && { relations: [...rest].sort(compareCaseRelations) }),
	};
}
