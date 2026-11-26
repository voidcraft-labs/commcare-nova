/**
 * A menu's Details tabs partition the fields shown in Details: each tab
 * starts at a different shown field, in Details order, and the first starts
 * at the first one (`detailTabSpans`). A tab of records may name the fields
 * that order its rows (`orderFields`): text or calculated fields of that
 * tab, in Details order.
 *
 * The twin of `caseListConfigSchema`'s rules over `detailTabs`, so the gate
 * refuses on every editor a batch the stored-document schema would reject.
 * Without it, a batch planned over an older document (a field removed, moved
 * or hidden there while a peer saved tabs) commits tabs that no longer cover
 * the shown fields, and both the suite and the HQ JSON emitters throw on
 * them (`longDetail.ts`, `hqJson/caseList.ts`).
 */

import type { Module, Uuid } from "@/lib/domain";
import { detailTabSpans } from "@/lib/domain/detailTabs";
import { type ValidationError, validationError } from "../../errors";

export function detailTabPartition(
	mod: Module,
	moduleUuid: Uuid,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (config?.detailTabs === undefined) return [];
	const location = { moduleUuid, moduleName: mod.name };
	const shown = new Set(
		config.columns
			.filter((column) => column.visibleInDetail !== false)
			.map((column) => column.uuid),
	);
	const fields = config.detailColumnOrder
		.filter((uuid) => shown.has(uuid))
		.map((uuid) => ({ uuid }));
	const spans = detailTabSpans(config.detailTabs, fields);
	if (spans === undefined)
		return [
			validationError(
				"CASE_DETAIL_TABS_INVALID",
				"module",
				`The Details tabs of "${mod.name}" no longer match the fields shown in Details. Each tab starts at a different field, in Details order, starting with the first field shown. You can open Edit tabs and save the tabs again.`,
				location,
				{ reason: "partition" },
			),
		];
	const errors: ValidationError[] = [];
	for (const { tab, start, end } of spans) {
		if (!tab.orderFields) continue;
		const own = fields
			.slice(start, end)
			.filter(({ uuid }) => tab.orderFields?.includes(uuid));
		const ordersItsRows =
			tab.rowSource !== undefined &&
			own.length === tab.orderFields.length &&
			own.every((field, i) => field.uuid === tab.orderFields?.[i]) &&
			own.every(({ uuid }) =>
				config.columns.some(
					(column) =>
						column.uuid === uuid &&
						(column.kind === "plain" || column.kind === "calculated"),
				),
			);
		if (ordersItsRows) continue;
		errors.push(
			validationError(
				"CASE_DETAIL_TABS_INVALID",
				"module",
				`The "${tab.title}" tab of "${mod.name}" orders its rows by a field it can't use. A tab of records orders its rows by text or calculated fields in that tab, in Details order. You can open Edit tabs and choose its ordering fields again.`,
				location,
				{ reason: "order-fields", tabUuid: tab.uuid, tabTitle: tab.title },
			),
		);
	}
	return errors;
}
