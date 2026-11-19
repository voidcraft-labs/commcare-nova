/**
 * Rule: a sort rule's name in the list's Sort by menu (`ColumnSort.label`)
 * stands only where a worker reads it.
 *
 * A worker picks a list's order from Sort by, which lists every field of the
 * list whose header is not blank (commcare-android
 * `EntitySelectActivity.getSortOptionsList`). A column shown on Results is
 * listed there under its own header. A column hidden from Results is listed
 * only where its rule names it: CommCare HQ's build gives its field a header
 * only where the sort element has display text
 * (`detail_screen.py::Invisible.header`), which Nova writes from the name
 * (`lib/domain/caseListOrder.ts`, rule 10). Three shapes put a name where no
 * worker reads it, and each is refused with its own reason:
 *
 *   - `blank`: the name is nothing but characters Python reads as spaces, so
 *     HQ's build reads it as no name (`models/case_list.py::SortElement.
 *     has_display_values`, `s.strip() != ''`) and writes no header.
 *   - `shown`: the name is on a column shown on Results, which Sort by lists
 *     under its header.
 *   - `lands-on-shown`: the column is hidden from Results, but its rule lands
 *     on an earlier column shown on Results over the same value
 *     (`caseListOrder.ts`, rule 5), which Sort by lists under that column's
 *     header.
 *
 * A name of characters up to U+0020 alone is refused by the schema, and a
 * name a device would show otherwise by `APP_STRING_VALUE_UNREPRESENTABLE`
 * over its translation unit.
 * The rule reads the order plan with the options every reader shares, with
 * media on.
 */

import {
	type BlueprintDoc,
	type Column,
	caseListOrderPlan,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { isPythonSpace } from "../../../localeFile";
import { caseListOrderOptions } from "../../../suite/case-list/orderPlanOptions";
import { type ValidationError, validationError } from "../../errors";
import { caseListColumnLabel, validationContextFor } from "./shared";

/** Why a column's name in Sort by is refused. */
export type SortLabelRefusal = "blank" | "shown" | "lands-on-shown";

/** The column's header, or its property where the header is blank. */
function headerOf(column: Column): string {
	const header = column.header.trim();
	if (header.length > 0) return header;
	return column.kind === "calculated" ? "Calculated value" : column.field;
}

/** The rule's sentence for a column whose name in Sort by is refused, which a
 *  tool's caller reads. `landing` is the shown column the rule lands on. */
export function sortLabelMessage(
	column: Column,
	reason: SortLabelRefusal,
	landing?: Column,
): string {
	const header = headerOf(column);
	if (reason === "blank")
		return `The "${header}" column's name in Sort by holds only spaces, so CommCare HQ lists it under no name. You can type a name, or remove it.`;
	return reason === "shown"
		? `The "${header}" column shows on Results, so workers already find it under its header in Sort by and its name there is never shown. You can remove the name, or hide the column on Results.`
		: `The "${header}" column's sort rule lands on the "${landing === undefined ? "earlier" : headerOf(landing)}" column, which shows on Results, so Sort by lists it under that column's header and its name there is never shown. You can remove the name, or hide that column on Results.`;
}

export function sortLabel(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (config === undefined) return [];
	const named = config.columns.filter(
		(column) => column.sort?.label !== undefined,
	);
	if (named.length === 0) return [];

	const caseProperties =
		validationContextFor(doc).augmentedCaseTypes.find(
			(caseType) => caseType.name === mod.caseType,
		)?.properties ?? [];
	const plan = caseListOrderPlan(
		config,
		caseProperties,
		caseListOrderOptions(mod, doc, true),
	);
	const authored = new Map(plan.authored.map((rule) => [rule.column, rule]));

	const errors: ValidationError[] = [];
	for (const column of named) {
		const columnIndex = config.columns.indexOf(column);
		let reason: SortLabelRefusal | undefined;
		let landing: Column | undefined;
		const label = column.sort?.label ?? "";
		if ([...label].every((char) => isPythonSpace(char.charCodeAt(0))))
			reason = "blank";
		else if (column.visibleInList !== false) reason = "shown";
		else {
			const landsOn = authored.get(column.uuid)?.landsOn;
			const field =
				typeof landsOn === "number" ? plan.fields[landsOn] : undefined;
			if (field !== undefined && !field.hidden) {
				reason = "lands-on-shown";
				landing = field.column;
			}
		}
		if (reason === undefined) continue;
		errors.push(
			validationError(
				"CASE_LIST_SORT_LABEL_NOT_SHOWN",
				"module",
				sortLabelMessage(column, reason, landing),
				{ moduleUuid, moduleName: mod.name },
				{
					slot: `caseListConfig.columns[${columnIndex}].sort.label`,
					columnIndex: String(columnIndex),
					columnUuid: column.uuid,
					columnLabel: caseListColumnLabel(column),
					reason,
					...(landing !== undefined && {
						landingColumnUuid: landing.uuid,
						landingColumnLabel: caseListColumnLabel(landing),
					}),
				},
			),
		);
	}
	return errors;
}
