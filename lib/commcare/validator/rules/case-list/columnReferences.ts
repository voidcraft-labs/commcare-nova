/**
 * Rule: every `Column.field` on `caseListConfig.columns` and
 * `caseListConfig.detailColumns` resolves to a property the module's
 * case type admits — declared on `ct.properties[]`, written by a
 * form field via `case_property_on === mod.caseType`, or part of
 * CommCare's standard set (`case_name`, `date_opened`, …).
 *
 * Walks every column kind regardless of arm: every entry in the
 * `Column` discriminated union carries a `field` slot, and every
 * runtime renderer reads the case property by that name.
 */

import type { BlueprintDoc, Column, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";
import { collectCaseProperties } from "../../index";
import { propertyExists } from "./shared";

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
	// Hoist the writer-prop set once per module (one app-walk vs one
	// per column) — passed into `propertyExists` so the existence
	// check stays O(columns).
	const writerProps =
		collectCaseProperties(doc, mod.caseType) ?? new Set<string>();

	checkColumns(
		mod,
		moduleUuid,
		"columns",
		config.columns,
		doc,
		writerProps,
		errors,
	);
	if (config.detailColumns) {
		checkColumns(
			mod,
			moduleUuid,
			"detailColumns",
			config.detailColumns,
			doc,
			writerProps,
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
	doc: BlueprintDoc,
	writerProps: ReadonlySet<string>,
	errors: ValidationError[],
): void {
	if (!mod.caseType) return;
	for (let index = 0; index < columns.length; index++) {
		const col = columns[index];
		if (propertyExists(doc, mod.caseType, col.field, writerProps)) continue;
		errors.push(
			validationError(
				"CASE_LIST_COLUMN_UNKNOWN_FIELD",
				"module",
				`Module "${mod.name}" has a ${SLOT_LABEL[slot]} (#${index + 1}) referencing field "${col.field}" (header: "${col.header}"), but no such property is declared on case type "${mod.caseType}", written to by any field via \`case_property_on\`, or part of the standard set ("case_name", "date_opened", …). Either add the property to the case type, write a field that saves to it, or use a standard property.`,
				{ moduleUuid, moduleName: mod.name },
				{ field: col.field, slot, index: String(index) },
			),
		);
	}
}
