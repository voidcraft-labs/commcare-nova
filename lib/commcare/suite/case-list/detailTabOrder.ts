import type { BlueprintDoc, Column, Module, Uuid } from "@/lib/domain";
import type { DetailTab } from "@/lib/domain/detailTabs";
import { columnFieldText } from "@/lib/domain/modules";
import type { LookupWireNaming } from "../../lookup/naming";
import type { ColumnFieldWordOf } from "../../wireIdentity";
import { serializeWire } from "../../xpath/wire/serialize";
import { columnPropertyPath, hqColumnFieldText } from "../wire";
import { fixtureRowFieldName } from "./fixtureRowField";
import {
	columnStoredAsExpression,
	hqExpressionField,
} from "./orderPlanOptions";

export function detailTabOrderField(
	column: Column,
	module: Module,
	doc: BlueprintDoc,
	naming?: LookupWireNaming,
	fieldWord?: ColumnFieldWordOf,
) {
	const word = fieldWord?.(column.uuid, "long");
	if (column.kind !== "calculated") {
		return columnStoredAsExpression(column)
			? columnPropertyPath(column)
			: hqColumnFieldText(columnFieldText(column), word);
	}
	const expression = hqExpressionField(column, module, doc, "details", naming);
	return fixtureRowFieldName(column, expression, word) ?? expression;
}

/** Every physically hidden field stays hidden. HQ gives the first occurrence
 * of an identical field its last occurrence's sort priority (get_nodeset_sort_elements,
 * get_sort_and_sort_only_columns and get_detail_column_infos_for_tabs_with_sorting). */
export function detailTabOrderPriorities(
	tab: DetailTab,
	module: Module,
	doc: BlueprintDoc,
	naming?: LookupWireNaming,
	fieldWord?: ColumnFieldWordOf,
): ReadonlyMap<Uuid, number> {
	const ordered = tab.orderFields ?? [];
	if (ordered.length <= 1) return new Map(ordered.map((uuid) => [uuid, 1]));
	const byId = new Map(module.caseListConfig?.columns.map((c) => [c.uuid, c]));
	const fields = new Map<string, { uuid: Uuid; priority: number }>();
	for (const [i, uuid] of ordered.entries()) {
		const column = byId.get(uuid);
		if (!column) continue;
		const field = detailTabOrderField(column, module, doc, naming, fieldWord);
		const key =
			typeof field === "string"
				? field
				: serializeWire(field, { target: "hq-json", interpolation: "none" })
						.text;
		fields.set(key, { uuid: fields.get(key)?.uuid ?? uuid, priority: i + 1 });
	}
	return new Map(
		[...fields.values()]
			.sort((a, b) => a.priority - b.priority)
			.map(({ uuid, priority }) => [uuid, priority]),
	);
}
