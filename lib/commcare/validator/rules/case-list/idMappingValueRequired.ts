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
 * Short-circuits cleanly when `caseListConfig` is absent or carries
 * no id-mapping columns.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
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
		if (column.kind !== "id-mapping") continue;
		for (let entryIndex = 0; entryIndex < column.mapping.length; entryIndex++) {
			const entry = column.mapping[entryIndex];
			if (entry.value !== "") continue;
			errors.push(
				validationError(
					"CASE_LIST_ID_MAPPING_EMPTY_VALUE",
					"module",
					`ID-mapping column "${column.header || column.field}" (column #${columnIndex + 1}) on module "${mod.name}" has an unfilled entry at row ${entryIndex + 1} (its \`value\` slot is empty). The wire layer matches the entry via \`selected(field, '<value>')\`, and CCHQ's \`selected()\` against an empty string matches every absent / cleared / empty property — so leaving the slot empty would silently apply this entry's label to every missing-property row. Either fill the row with the case property value it should match, or remove the row from the mapping.`,
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
