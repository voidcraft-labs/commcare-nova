/**
 * Step `sort-property-ownership`: rewrites what
 * `CASE_LIST_SORT_PROPERTY_AMBIGUOUS` refuses. CommCare HQ joins an order
 * rule to a column by its join text alone, keeps one rule per text, and
 * gives it to the FIRST column with that text
 * (`lib/domain/caseListOrder.ts`, rule 5). Two passes, over the order plan
 * the rule reads, built with the options every reader shares and media on:
 *
 *   (a) Of the order rules with one join text, the first in rule order (the
 *       one the builder, Preview and a downloaded app follow today) is kept
 *       and the others are removed. One `order-rule-removed-same-property`
 *       line per removed rule, naming its column, with the menu's name and
 *       the kept column's name in `detail.kept`.
 *   (b) On the plan of what remains, a rule that lands on another column
 *       whose key differs from its own moves to that column, with its
 *       direction and priority. After (a) a list holds one rule per join
 *       text, so that column holds none. One
 *       `order-rule-moved-to-first-column` line per moved rule, naming the
 *       column it left, with the menu's name and the column it moved to in
 *       `detail.first`.
 *
 * It runs after `tile-hidden-calculated-sort`, so a rule that step removes is
 * never moved first.
 */

import {
	caseListOrderOptions,
	moduleCaseListOrderPlan,
} from "@/lib/commcare/suite/case-list/orderPlanOptions";
import {
	asUuid,
	type BlueprintDoc,
	type CaseListOrderPlan,
	caseListSortKeysMatch,
	type Module,
} from "@/lib/domain";
import type { RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange } from "../transform";
import {
	columnEntity,
	columnName,
	menuName,
	type RawCaseList,
	rawCaseLists,
	typedView,
	writableRecord,
} from "./caseLists";

function planOf(module: Module, doc: BlueprintDoc): CaseListOrderPlan {
	return moduleCaseListOrderPlan(module, doc, true);
}

/** Set or remove a column's order rule, in the stored list and its view. */
function writeSort(
	list: RawCaseList,
	module: Module,
	columnUuid: string,
	sort: unknown,
): void {
	const raw = list.columns.find((column) => column.uuid === columnUuid);
	const typed = module.caseListConfig?.columns.find(
		(column) => column.uuid === columnUuid,
	);
	if (raw === undefined || typed === undefined) {
		throw new Error(
			`Menu "${menuName(list)}" has no column ${columnUuid}, so step sort-property-ownership cannot move its order rule.`,
		);
	}
	const writableTyped = typed as unknown as Record<string, unknown>;
	if (sort === undefined) {
		delete writableRecord(raw).sort;
		delete writableTyped.sort;
		return;
	}
	writableRecord(raw).sort = structuredClone(sort);
	writableTyped.sort = structuredClone(sort);
}

function rawColumn(list: RawCaseList, columnUuid: string) {
	const column = list.columns.find(
		(candidate) => candidate.uuid === columnUuid,
	);
	if (column === undefined) {
		throw new Error(
			`Menu "${menuName(list)}" has no column ${columnUuid}, which its order plan names, so step sort-property-ownership cannot read it.`,
		);
	}
	return column;
}

export const sortPropertyOwnershipStep: CutoverStep = {
	id: "sort-property-ownership",
	apply(document: RawDocument, context) {
		const lists = rawCaseLists(document).filter((list) =>
			list.columns.some((column) => column.sort !== undefined),
		);
		if (lists.length === 0) return [];
		const view = typedView(document, context.appId);
		const changes: DocumentChange[] = [];
		for (const list of lists) {
			const module = view.modules[asUuid(list.moduleUuid)];
			const config = module?.caseListConfig;
			if (module === undefined || config === undefined) continue;

			// (a) one join text, two rules: the first in rule order keeps it.
			const firstByJoinText = new Map<string, string>();
			for (const rule of planOf(module, view).authored) {
				const kept = firstByJoinText.get(rule.joinText);
				if (kept === undefined) {
					firstByJoinText.set(rule.joinText, rule.column);
					continue;
				}
				const removed = rawColumn(list, rule.column);
				writeSort(list, module, rule.column, undefined);
				changes.push({
					reason: "order-rule-removed-same-property",
					entity: columnEntity(removed),
					detail: {
						menu: menuName(list),
						kept: columnName(rawColumn(list, kept)),
					},
				});
			}

			// (b) a rule that lands on an earlier column that orders differently
			// moves to that column.
			const plan = planOf(module, view);
			const options = caseListOrderOptions(module, view, true);
			const moves = plan.authored.flatMap((rule) => {
				if (typeof rule.landsOn !== "number") return [];
				const landing = plan.fields[rule.landsOn];
				if (landing === undefined || landing.column.uuid === rule.column) {
					return [];
				}
				if (
					landing.key !== undefined &&
					caseListSortKeysMatch(
						plan,
						config.columns,
						rule.ownKey,
						landing.key,
						options.expressionText,
					)
				) {
					return [];
				}
				return [{ from: rule.column, to: landing.column.uuid }];
			});
			for (const { from, to } of moves) {
				const source = rawColumn(list, from);
				const target = rawColumn(list, to);
				if (target.sort !== undefined) {
					throw new Error(
						`In menu "${menuName(list)}", the order rule on "${columnName(source)}" lands on "${columnName(target)}", which holds an order rule of its own, so step sort-property-ownership has no column to move it to.`,
					);
				}
				writeSort(list, module, to, source.sort);
				writeSort(list, module, from, undefined);
				changes.push({
					reason: "order-rule-moved-to-first-column",
					entity: columnEntity(source),
					detail: { menu: menuName(list), first: columnName(target) },
				});
			}
		}
		return changes;
	},
};
