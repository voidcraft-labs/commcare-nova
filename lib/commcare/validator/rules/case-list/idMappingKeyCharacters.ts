/**
 * Rule: an ID-mapping entry's `value` holds none of `&`, `<`, `>`, `"`
 * or `'`.
 *
 * CommCare HQ stores an ID mapping as an `enum` column whose keys are the
 * entry values, and both of its readers of a key break on one of the five:
 *
 *   - HQ's build writes the key unescaped between straight apostrophes
 *     into the column's expression (`corehq/apps/app_manager/detail_screen.py::Enum._xpath_template`,
 *     `if(selected({xpath}, '{key}'), …)`), so a key holding `'` closes
 *     the literal early. CommCare refuses to install the archive, and the
 *     whole app fails to install from HQ.
 *   - HQ's mapping dialog refuses a key holding any of the five as bad XML
 *     (`corehq/apps/hqwebapp/static/hqwebapp/js/ui_elements/bootstrap5/ui-element-key-val-mapping.js::hasBadXML`,
 *     `key.match(/[&<>"']/)` for a mapping whose values are not icons or
 *     conditions): with one stored, its OK button is disabled, so a person
 *     in HQ can change nothing in that mapping until they remove the key.
 *
 * An image map takes no such rule: the dialog accepts any key of an
 * `enum-image` column (`values_are_icons`, set in
 * `corehq/apps/app_manager/static/app_manager/js/details/bootstrap5/column.js`),
 * and Nova quotes the value itself. Columns are counted in stored order, as
 * `imageMapValueUnique` counts them.
 */

import {
	type BlueprintDoc,
	idMappingValueHoldsForbiddenCharacter,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";
import { describeColumn } from "./shared";

export function idMappingKeyCharacters(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const columns = mod.caseListConfig?.columns ?? [];
	const errors: ValidationError[] = [];
	for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
		const column = columns[columnIndex];
		if (column.kind !== "id-mapping") continue;
		for (let rowIndex = 0; rowIndex < column.mapping.length; rowIndex++) {
			const { value } = column.mapping[rowIndex];
			if (!idMappingValueHoldsForbiddenCharacter(value)) continue;
			errors.push(
				validationError(
					"CASE_LIST_ID_MAPPING_KEY_CHARACTERS",
					"module",
					`ID-mapping column ${describeColumn(column, columnIndex)} on module "${mod.name}" maps the value "${value}" (row ${rowIndex + 1}). An ID mapping value can't hold &, <, >, " or ': CommCare HQ's ID mapping has no way to store one. Change the value or remove the row.`,
					{ moduleUuid, moduleName: mod.name },
					{
						slot: `caseListConfig.columns[${columnIndex}].mapping[${rowIndex}].value`,
						columnIndex: String(columnIndex),
						rowIndex: String(rowIndex),
						columnUuid: column.uuid,
						value,
					},
				),
			);
		}
	}
	return errors;
}
