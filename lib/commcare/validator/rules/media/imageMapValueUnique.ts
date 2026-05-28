/**
 * Rule: within one image-map column, every mapping entry's `value`
 * is unique.
 *
 * The image-map column's wire shape is the id-mapping chain with
 * image paths inlined — one nested `if(selected(<field>,
 * '<value>'), <jr://path>, ...)` arm per mapping row. Two rows that
 * share the same `value` collapse to one wire arm: the first row's
 * image always wins, the duplicate row is dead. The schema's
 * top-level `.refine()` rejects duplicates at parse time, so the
 * common path never reaches this rule — but the SA's tool surface
 * builds `.partial()` patches that bypass the refine, and tests
 * commonly construct columns without round-tripping through Zod.
 * This rule is the totality backstop.
 *
 * Cousin columns can share a value freely (the wire arm is per-
 * column); only siblings inside one column collide. The rule's
 * inner loop scopes the uniqueness check to one column at a time.
 *
 * Mirrors `idMappingValueRequired`'s shape: module scope; iterate
 * `caseListConfig.columns`; emit one error per duplicate row with
 * 1-based human-readable row index in the message.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function imageMapValueUnique(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const columns = mod.caseListConfig?.columns ?? [];
	if (columns.length === 0) return [];

	const errors: ValidationError[] = [];
	for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
		const column = columns[columnIndex];
		if (column.kind !== "image-map") continue;

		// Track each `value` against the row index it first appeared at,
		// so the duplicate error can name the original alongside the
		// duplicate — both rows are equally informative to a user
		// reading the error.
		const firstSeen = new Map<string, number>();
		for (let rowIndex = 0; rowIndex < column.mapping.length; rowIndex++) {
			const entry = column.mapping[rowIndex];
			const prior = firstSeen.get(entry.value);
			if (prior !== undefined) {
				errors.push(
					validationError(
						"CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE",
						"module",
						`Image-map column "${column.header || column.field}" (column #${columnIndex + 1}) on module "${mod.name}" has two rows that share the value "${entry.value}" (rows ${prior + 1} and ${rowIndex + 1}). Each case-property value can map to at most one image — only the first row's image would ever display, so the duplicate row is dead. Change one row's value, or remove the duplicate.`,
						{ moduleUuid, moduleName: mod.name },
						{
							columnIndex: String(columnIndex),
							firstRowIndex: String(prior),
							duplicateRowIndex: String(rowIndex),
							columnUuid: column.uuid,
							value: entry.value,
						},
					),
				);
			} else {
				firstSeen.set(entry.value, rowIndex);
			}
		}
	}

	return errors;
}
