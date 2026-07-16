/**
 * Rule: every `id-mapping` column's `mapping` entries carry a
 * non-empty `value`.
 *
 * The schema admits an empty `value` as the editor's "row added,
 * not yet filled" transient state — without that affordance, the
 * "Add mapping" button would have to seed a placeholder string,
 * which would either collide with real authoring intent or force a
 * post-add edit. The validator is the trust boundary that keeps
 * the transient state from reaching wire: the wire emits the
 * mapping as `selected(<field>, '<value>')`, and CCHQ's XPath 1.0
 * `selected()` against `''` matches every empty-or-absent property
 * value — silently mapping every "missing" row to whatever label
 * the empty-value entry carries.
 *
 * Short-circuits cleanly when `caseListConfig` is absent or carries no
 * runtime-active id-mapping columns. Fully off-screen, unsorted legacy
 * mappings remain recoverable but cannot block an otherwise valid export.
 */

import {
	type BlueprintDoc,
	caseListColumnHasRuntimeRole,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function idMappingValueRequired(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const columns = mod.caseListConfig?.columns ?? [];
	if (columns.length === 0) return [];

	const errors: ValidationError[] = [];
	for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
		const column = columns[columnIndex];
		if (!caseListColumnHasRuntimeRole(column)) continue;
		if (column.kind !== "id-mapping") continue;
		for (let entryIndex = 0; entryIndex < column.mapping.length; entryIndex++) {
			const entry = column.mapping[entryIndex];
			if (entry.value !== "") continue;
			errors.push(
				validationError(
					"CASE_LIST_ID_MAPPING_EMPTY_VALUE",
					"module",
					`ID-mapping column "${column.header || column.field}" (column #${columnIndex + 1}) on module "${mod.name}" has an empty value at row ${entryIndex + 1} — an empty value would match every case missing that property. Fill the row with the case property value it should match, or remove the row.`,
					{ moduleUuid, moduleName: mod.name },
					{
						columnIndex: String(columnIndex),
						entryIndex: String(entryIndex),
						columnUuid: column.uuid,
					},
				),
			);
		}
	}

	return errors;
}
