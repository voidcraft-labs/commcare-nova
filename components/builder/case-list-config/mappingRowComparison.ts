// components/builder/case-list-config/mappingRowComparison.ts
//
// What a mapping row's comparison menu changes on the row. Pure, so the
// card's commit is a function of the row and the choice alone.

import type { CaseMappingRow } from "@/lib/domain/caseMappingRows";
import { matchAll } from "@/lib/domain/expression/builders";
import { newUuid } from "./uuid";

export type MappingComparisonMode = "condition" | "exact" | "selected";

/**
 * The patch that turns `row` into a row of `mode`. A condition row is
 * addressed by its identity (the gate refuses one with none), so a row
 * saved before rows carried identities is given one as it becomes a
 * condition.
 */
export function mappingComparisonPatch(
	row: CaseMappingRow,
	mode: MappingComparisonMode,
	image: boolean,
): Partial<CaseMappingRow> {
	if (mode === "condition")
		return {
			when: matchAll(),
			value: undefined,
			...(row.uuid === undefined && { uuid: newUuid() }),
			...(image && { match: undefined }),
		};
	return {
		value: row.value ?? "",
		when: undefined,
		...(image && { match: mode === "exact" ? "exact" : undefined }),
	};
}
