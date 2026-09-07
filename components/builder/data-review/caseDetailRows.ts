import type { ProseProjector } from "@/lib/doc/hooks/useProseProjection";
import type { CaseProperty, CaseType } from "@/lib/domain";
import { caseRowDisplaySourceValue } from "@/lib/preview/engine/caseDataBindingClient";
import type {
	CaseRowWithCalculated,
	JsonValue,
} from "@/lib/preview/engine/caseDataBindingTypes";

/**
 * A stored value as the person who typed it knows it: select values
 * resolve to their option labels, multi-select arrays read as their
 * comma-separated selections.
 */
function displayCaseValue(
	decl: CaseProperty | undefined,
	raw: JsonValue | Date | undefined,
	projectProse: ProseProjector,
): string {
	if (raw === undefined || raw === null || raw === "") return "";
	if (raw instanceof Date) return raw.toISOString();
	const optionLabel = (value: string): string => {
		const option = decl?.options?.find(
			(candidate) => candidate.value === value,
		);
		return option ? projectProse(option.label) : value;
	};
	if (Array.isArray(raw))
		return raw.map((v) => optionLabel(String(v))).join(", ");
	return optionLabel(String(raw));
}

export function caseDetailRows(
	caseType: CaseType,
	row: CaseRowWithCalculated,
	projectProse: ProseProjector,
) {
	// Declared properties in catalog order, then any saved keys the
	// schema no longer declares (renamed/retired properties keep their
	// data): the table shows everything the case holds, not just what
	// the current schema names.
	const rows: Array<{
		key: string;
		decl: CaseProperty | undefined;
		value: string;
	}> = [];
	if (row !== null) {
		const seen = new Set<string>(["case_name"]);
		const caseNameDecl = caseType.properties.find(
			(property) => property.name === "case_name",
		);
		rows.push({
			key: "case_name",
			decl: caseNameDecl,
			value: displayCaseValue(
				caseNameDecl,
				caseRowDisplaySourceValue(row, "case_name"),
				projectProse,
			),
		});
		for (const decl of caseType.properties) {
			if (seen.has(decl.name)) continue;
			seen.add(decl.name);
			rows.push({
				key: decl.name,
				decl,
				value: displayCaseValue(
					decl,
					caseRowDisplaySourceValue(row, decl.name),
					projectProse,
				),
			});
		}
		for (const key of Object.keys(row.properties)) {
			if (seen.has(key)) continue;
			rows.push({
				key,
				decl: undefined,
				value: displayCaseValue(
					undefined,
					caseRowDisplaySourceValue(row, key),
					projectProse,
				),
			});
		}
	}

	return rows;
}
