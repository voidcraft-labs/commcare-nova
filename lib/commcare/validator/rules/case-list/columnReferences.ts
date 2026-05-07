/**
 * Rule: every `Column.field` on `caseListConfig.columns` and
 * `caseListConfig.detailColumns` must resolve to a known case property
 * on the module's case type — either a CommCare standard property
 * (`case_name`, `date_opened`, etc.) or a property declared by a field
 * with `case_property_on === mod.caseType`.
 *
 * Walks every column kind regardless of arm: every entry in the
 * `Column` discriminated union carries a `field` slot, and every
 * runtime renderer reads the case property by that name.
 */

import { STANDARD_CASE_LIST_PROPERTIES } from "@/lib/commcare";
import type { BlueprintDoc, Column, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";
import { collectCaseProperties } from "../../index";

/**
 * Identifies which slot a column came from. `columns` is the short
 * detail; `detailColumns` is the optional long-detail override. The
 * label appears in the error message so authors can locate the
 * offending entry without counting indices across both lists.
 */
type ColumnSlot = "columns" | "detailColumns";

const SLOT_LABEL: Record<ColumnSlot, string> = {
	columns: "case-list column",
	detailColumns: "case-detail column",
};

export function columnReferences(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (!config || !mod.caseType) return [];

	const errors: ValidationError[] = [];
	const knownProps = collectCaseProperties(doc, mod.caseType) ?? new Set();

	checkColumns(mod, moduleUuid, "columns", config.columns, knownProps, errors);
	if (config.detailColumns) {
		checkColumns(
			mod,
			moduleUuid,
			"detailColumns",
			config.detailColumns,
			knownProps,
			errors,
		);
	}

	return errors;
}

function checkColumns(
	mod: Module,
	moduleUuid: Uuid,
	slot: ColumnSlot,
	columns: readonly Column[],
	knownProps: ReadonlySet<string>,
	errors: ValidationError[],
): void {
	for (let index = 0; index < columns.length; index++) {
		const col = columns[index];
		if (STANDARD_CASE_LIST_PROPERTIES.has(col.field)) continue;
		if (knownProps.has(col.field)) continue;
		errors.push(
			validationError(
				"CASE_LIST_COLUMN_UNKNOWN_FIELD",
				"module",
				`Module "${mod.name}" has a ${SLOT_LABEL[slot]} (#${index + 1}) referencing field "${col.field}" (header: "${col.header}"), but no field saves to a case property with that name. Either add a field with id "${col.field}" and \`case_property_on\`: "${mod.caseType}", or use a standard property like "case_name" or "date_opened".`,
				{ moduleUuid, moduleName: mod.name },
				{ field: col.field, slot, index: String(index) },
			),
		);
	}
}
