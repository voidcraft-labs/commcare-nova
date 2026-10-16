/**
 * Rule: every order rule orders the list as authored, which CommCare HQ's
 * build guarantees only where no two rules share a join text and no rule
 * lands on a column that orders differently.
 *
 * HQ joins a sort element to a column by the column's `field` text and
 * nothing else. It keeps the joined elements in one dict keyed by that text,
 * a later element replacing an earlier one
 * (`corehq/apps/app_manager/util.py::get_sort_and_sort_only_columns`), and
 * gives each to the FIRST column with that text
 * (`suite_xml/sections/details.py::get_detail_column_infos`). So two shapes
 * have no spelling HQ's build can hold:
 *
 *   - `same-value`: two order rules whose elements have one join text (one
 *     property name, one `@<name>`, or one expression text). Only the later
 *     survives on HQ's build, while a downloaded app and Preview follow
 *     both. The finding is on the later rule in priority order, the one the
 *     cutover removes.
 *   - `first-column-differs`: an element that lands on an earlier column
 *     whose sort key differs from the key the authored column would have
 *     under the rule (a plain column after an ID mapping over its property,
 *     a hidden column after an image map over it, a property that a
 *     calculated column prints bare).
 *
 * Where the join lands on another column with the SAME key (a hidden order
 * carrier after a shown plain column over one property), every runtime
 * orders as authored and nothing is refused.
 *
 * The rule reads the order plan's join texts and keys
 * (`lib/domain/caseListOrder.ts::caseListOrderPlan`), never wire text, and
 * builds the plan with the options every reader shares, with media on: whether
 * a document is admitted cannot depend on an export option. Columns are
 * counted in stored order.
 */

import {
	type BlueprintDoc,
	type CaseListOrderPlan,
	type CaseListShortField,
	type Column,
	caseListOrderPlan,
	caseListSortKeysMatch,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { caseListOrderOptions } from "../../../suite/case-list/orderPlanOptions";
import { type ValidationError, validationError } from "../../errors";
import {
	caseListColumnLabel,
	describeColumn,
	validationContextFor,
} from "./shared";

export function sortPropertyOwnership(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (config === undefined) return [];
	const columns = config.columns;
	if (!columns.some((column) => column.sort !== undefined)) {
		return [];
	}

	const caseProperties =
		validationContextFor(doc).augmentedCaseTypes.find(
			(caseType) => caseType.name === mod.caseType,
		)?.properties ?? [];
	const options = caseListOrderOptions(mod, doc, true);
	const plan = caseListOrderPlan(config, caseProperties, options);

	const indexByUuid = new Map(
		columns.map((column, index) => [column.uuid, index] as const),
	);
	const location = { moduleUuid, moduleName: mod.name };
	const errors: ValidationError[] = [];

	// (a) one join text, two rules: the first in rule order keeps it.
	const firstByJoinText = new Map<string, Uuid>();
	const sameValue = new Set<Uuid>();
	for (const rule of plan.authored) {
		const first = firstByJoinText.get(rule.joinText);
		if (first === undefined) {
			firstByJoinText.set(rule.joinText, rule.column);
			continue;
		}
		sameValue.add(rule.column);
		const columnIndex = indexByUuid.get(rule.column);
		const otherIndex = indexByUuid.get(first);
		if (columnIndex === undefined || otherIndex === undefined) continue;
		const column = columns[columnIndex];
		const other = columns[otherIndex];
		errors.push(
			validationError(
				"CASE_LIST_SORT_PROPERTY_AMBIGUOUS",
				"module",
				`Module "${mod.name}" has two order rules over one value, on ${describeColumn(other, otherIndex)} and on ${describeColumn(column, columnIndex)}. CommCare keeps one order rule for each value, so only one of them would order the list. Remove the sort from one of the two columns.`,
				location,
				{
					...columnDetails(column, columnIndex),
					shape: "same-value",
					otherUuid: other.uuid,
					otherLabel: caseListColumnLabel(other),
				},
			),
		);
	}

	// (b) a rule that lands on an earlier field that orders differently.
	for (const rule of plan.authored) {
		if (sameValue.has(rule.column)) continue;
		const landing = landingField(plan, rule.landsOn);
		if (landing === undefined || landing.column.uuid === rule.column) continue;
		const first = landing.column;
		if (
			landing.key !== undefined &&
			caseListSortKeysMatch(
				plan,
				columns,
				rule.ownKey,
				landing.key,
				options.expressionText,
			)
		) {
			continue;
		}
		const columnIndex = indexByUuid.get(rule.column);
		const firstIndex = indexByUuid.get(first.uuid);
		if (columnIndex === undefined || firstIndex === undefined) continue;
		const column = columns[columnIndex];
		errors.push(
			validationError(
				"CASE_LIST_SORT_PROPERTY_AMBIGUOUS",
				"module",
				`The order rule on ${describeColumn(column, columnIndex)} in module "${mod.name}" would go to ${describeColumn(first, firstIndex)}: CommCare gives an order rule to the first column with the same value, and that column orders differently. Put the sort on ${describeColumn(first, firstIndex)}, or move ${describeColumn(column, columnIndex)} ahead of it in the Results order.`,
				location,
				{
					...columnDetails(column, columnIndex),
					shape: "first-column-differs",
					firstUuid: first.uuid,
					firstLabel: caseListColumnLabel(first),
				},
			),
		);
	}

	return errors;
}

/** The field a rule lands on; none for a carrier or for a rule another rule
 *  with its join text replaced. */
function landingField(
	plan: CaseListOrderPlan,
	landsOn: number | "carrier" | undefined,
): CaseListShortField | undefined {
	return typeof landsOn === "number" ? plan.fields[landsOn] : undefined;
}

function columnDetails(
	column: Column,
	columnIndex: number,
): Record<string, string> {
	return {
		slot: `caseListConfig.columns[${columnIndex}].sort`,
		columnIndex: String(columnIndex),
		columnUuid: column.uuid,
	};
}
