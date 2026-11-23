import type { CaseType, Column } from "@/lib/domain";
import { casePropertyShowsOptionLabels } from "@/lib/domain/caseListOrder";
import { columnPropertyCaseType } from "@/lib/domain/columnRelation";
import { caseListColumnTextShows } from "@/lib/domain/modules";

/** Two plain columns over one property can be physically distinct in HQ. A label
 * expression and a raw stored field stay distinguishable after a worker layout edit. */
export function storedColumnKind(
	column: Column,
	start: string | undefined,
	caseTypes: readonly CaseType[],
) {
	if (column.kind === "id-mapping" && column.behavior === "first-match")
		return "conditional-label" as const;
	if (column.kind === "calculated" && column.showAs === "formatted-text")
		return "calculated-formatted-text" as const;
	if (
		column.kind !== "plain" ||
		column.showChoice === "saved-value" ||
		!caseListColumnTextShows(column)
	)
		return column.kind;
	const owner = columnPropertyCaseType(column, start, caseTypes);
	const property = caseTypes
		.find((type) => type.name === owner)
		?.properties.find((p) => p.name === column.field);
	return casePropertyShowsOptionLabels(property)
		? ("choice-label" as const)
		: ("plain" as const);
}
