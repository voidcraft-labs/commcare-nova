/**
 * Rule: a date column's `pattern` holds no straight apostrophe (U+0027).
 *
 * CommCare HQ writes a date column's pattern unescaped between straight
 * apostrophes (`corehq/apps/app_manager/detail_screen.py::Date.XPATH_FUNCTION`,
 * `format-date(date({xpath}), '{column.date_format}')`), so a pattern
 * holding `'` closes the literal early: CommCare refuses to install the
 * archive HQ builds, and HQ's Case List page cannot load the column to save
 * it. Every other character a pattern may hold builds and shows the same
 * text from HQ as from a downloaded app, which quotes the pattern itself.
 *
 * The curved apostrophe (U+2019) is the replacement the message offers. A
 * calculated column's `format-date` is no concern here: Nova prints that
 * expression whole, quoted, and HQ uses an expression column's text as it
 * stands. Columns are counted in stored order.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";
import { describeColumn } from "./shared";

export function dateColumnPattern(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const columns = mod.caseListConfig?.columns ?? [];
	const errors: ValidationError[] = [];
	for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
		const column = columns[columnIndex];
		if (column.kind !== "date" || !column.pattern.includes("'")) continue;
		errors.push(
			validationError(
				"CASE_LIST_DATE_PATTERN_APOSTROPHE",
				"module",
				`Date column ${describeColumn(column, columnIndex)} on module "${mod.name}" has the pattern "${column.pattern}", which holds a straight apostrophe ('). CommCare HQ's date column has no way to store one. Use a curved one (’) instead.`,
				{ moduleUuid, moduleName: mod.name },
				{
					slot: `caseListConfig.columns[${columnIndex}].pattern`,
					columnIndex: String(columnIndex),
					columnUuid: column.uuid,
					pattern: column.pattern,
				},
			),
		);
	}
	return errors;
}
