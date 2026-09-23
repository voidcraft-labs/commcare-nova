// components/preview/shared/caseColumnLabel.ts
//
// One name for a case-list column, shared by every running surface that
// has to say what a value IS: the results table's header and per-row
// labels, the detail confirm's terms, and a tile cell's assistive label.
// A tile draws no header row, so this is the only place a screen-reader
// user learns which property a cell holds; letting a surface invent its
// own fallback would mean two surfaces naming one column differently.

import type { ProseTemplate } from "@/lib/domain";
import { propertyDisplayLabelForName } from "@/lib/domain/propertyDisplay";

type ProseProjector = (template: ProseTemplate) => string;

import type { CaseListConfig, CaseProperty } from "@/lib/domain";

export function caseColumnLabel(
	col: CaseListConfig["columns"][number],
	caseProperties: readonly CaseProperty[],
	project: ProseProjector,
): string {
	const authoredHeader = col.header.trim();
	if (authoredHeader !== "") return authoredHeader;
	if (col.kind === "calculated") return "Calculated value";
	const field = col.field.trim();
	return field === ""
		? "Case information"
		: propertyDisplayLabelForName(field, caseProperties, project);
}
