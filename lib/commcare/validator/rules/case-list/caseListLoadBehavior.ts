/**
 * A column's load behavior (how a phone loads its value) belongs to a column
 * that can use one (`columnSupportsLoadBehavior`: a calculated value without
 * its own wording or a row field, or a link) on a case list whose faster
 * loading is on.
 *
 * The twin of `caseListConfigSchema`'s rules over `loadBehavior`, so the gate
 * refuses on every editor a batch the stored-document schema would reject.
 * Without it, a column tool sent a behavior before faster loading is on (the
 * order the field's own description reads in), or a merge that clears the
 * list's setting while a peer sets a column's choice, commits a document
 * whose save then fails parsing it, with no word for the person.
 */

import {
	columnSupportsLoadBehavior,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function caseListLoadBehavior(
	mod: Module,
	moduleUuid: Uuid,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (config === undefined) return [];
	const location = { moduleUuid, moduleName: mod.name };
	const errors: ValidationError[] = [];
	for (const column of config.columns) {
		if (!("loadBehavior" in column) || column.loadBehavior === undefined)
			continue;
		const label = column.header || ("field" in column ? column.field : "");
		const subject = label ? `"${label}"` : "A column";
		const unusable = !columnSupportsLoadBehavior(column);
		if (!unusable && config.optimizations === true) continue;
		errors.push(
			validationError(
				"CASE_LIST_LOAD_BEHAVIOR_INVALID",
				"module",
				unusable
					? `${subject} in "${mod.name}" chooses how a phone loads it, which only a calculated value or a link can. You can clear its loading choice.`
					: `${subject} in "${mod.name}" chooses how a phone loads it, and the case list's faster loading is off. You can turn on faster loading for the case list, or clear the column's loading choice.`,
				location,
				{
					reason: unusable ? "column" : "list-off",
					columnUuid: column.uuid,
					...(label && { columnLabel: label }),
				},
			),
		);
	}
	return errors;
}
