/**
 * Rule: in a list with a tile layout, a column hidden from Results carries
 * no order rule when it is calculated or reads `case_id`.
 *
 * A column hidden from Results is no field of a tile's short detail, so its
 * order rule reaches CommCare HQ as a sort row with no stored column, and HQ
 * appends the hidden field that carries it
 * (`corehq/apps/app_manager/util.py::create_temp_sort_column`). That
 * spelling exists only for a rule HQ can name by a property:
 *
 *   - A calculated column's rule is a positional element
 *     (`_cc_calculated_<i>`), which HQ reads as the stored column at that
 *     position (`util.py::get_sort_and_sort_only_columns`). A stored column
 *     in a tile is given a cell by HQ's Case List save (`static/app_manager/js/details/bootstrap5/column.js`,
 *     `serialize`), and the build then styles it, so one save changes the
 *     tile. The other spelling, a sort row carrying its own calculation, is
 *     emptied by that save unless the project has `SORT_CALCULATION_IN_CASE_LIST`
 *     (`views/modules.py::_update_sort_elements`).
 *   - `case_id` has no property element: a sort row named `@case_id` is
 *     refused by HQ's validation (`helpers/validators.py::ModuleDetailValidatorMixin._validate_detail_screen_field`),
 *     and the bare `case_id` reads a child element no case has
 *     (`detail_screen.py::CASE_PROPERTY_MAP` has no entry for it), so the
 *     appended field is blank on every row. Its rule can only be positional
 *     on a stored column, exactly as a calculated column's.
 *
 * Every other hidden column's rule, `owner_id` and `status` among them,
 * rides as a sort row on its property. The code keeps one name for both
 * shapes: each is a stored expression column. Columns are counted in stored
 * order.
 */

import type { BlueprintDoc, Column, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";
import { describeColumn } from "./shared";

/** The shape of a hidden tile order rule this rule refuses, or `undefined`. */
function refusedShape(column: Column): "calculated" | "case_id" | undefined {
	if (column.visibleInList !== false || column.sort === undefined) {
		return undefined;
	}
	if (column.kind === "calculated") return "calculated";
	return column.field === "case_id" ? "case_id" : undefined;
}

export function caseTileHiddenCalculatedSort(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (config?.tile === undefined) return [];
	const errors: ValidationError[] = [];
	for (
		let columnIndex = 0;
		columnIndex < config.columns.length;
		columnIndex++
	) {
		const column = config.columns[columnIndex];
		const shape = refusedShape(column);
		if (shape === undefined) continue;
		const described = describeColumn(column, columnIndex);
		const message =
			shape === "calculated"
				? `Calculated column ${described} on module "${mod.name}" is hidden from Results and carries an order rule, and the module's list is a case tile. A tile list can't order by a calculation that isn't on the tile. Show the column on Results and place it on the tile, order by a case property instead, or remove the rule.`
				: `Column ${described} on module "${mod.name}" reads case_id, is hidden from Results and carries an order rule, and the module's list is a case tile. A tile list can't order by case_id unless the column is on the tile. Show the column on Results and place it on the tile, or remove the rule.`;
		errors.push(
			validationError(
				"CASE_TILE_HIDDEN_CALCULATED_SORT",
				"module",
				message,
				{ moduleUuid, moduleName: mod.name },
				{
					slot: `caseListConfig.columns[${columnIndex}].sort`,
					columnIndex: String(columnIndex),
					columnUuid: column.uuid,
					shape,
				},
			),
		);
	}
	return errors;
}
