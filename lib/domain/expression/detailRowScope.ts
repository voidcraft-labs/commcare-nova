import type { BlueprintDoc } from "../blueprint";
import { detailTabForColumn } from "../detailTabs";
import type { Column, Module } from "../modules";
import { type LookupTypeIndex, type RowScope, slotContext } from "./context";
import { expressionRowScope } from "./typeChecker";

/** The data tab's fields read each item in the collection. Only its show/hide
 * rule reads the selected outer case. */
export function detailColumnRowScope(
	doc: BlueprintDoc,
	mod: Module,
	column: Column,
	tables: LookupTypeIndex = new Map(),
): RowScope | undefined {
	const tab = detailTabForColumn(mod.caseListConfig, column.uuid);
	const source = tab?.rowSource;
	if (!source || !tab) return;
	if (source.kind === "children")
		return { kind: "case", caseType: source.caseType, root: "casedb" };
	const context = slotContext(
		doc,
		{
			entity: "module",
			uuid: mod.uuid,
			slot: "case_detail_tab_rows",
			member: { tabUuid: tab.uuid },
		},
		tables,
	);
	return context && expressionRowScope(source.rows, context);
}

export function columnRunsOnResults(mod: Module, column: Column) {
	return (
		column.notOnList !== true &&
		(column.visibleInList !== false || !mod.caseListConfig?.tile)
	);
}

/** A shared property column must exist in every scope where it is printed.
 * A Details-only property of a child never becomes a property of its parent. */
export function columnCaseScopes(
	doc: BlueprintDoc,
	mod: Module,
	column: Column,
) {
	const row = detailColumnRowScope(doc, mod, column);
	const detailType =
		row?.kind === "case" ? row.caseType : row ? undefined : mod.caseType;
	return [
		...new Set(
			[
				detailType,
				...(columnRunsOnResults(mod, column) ? [mod.caseType] : []),
			].filter((type): type is string => type !== undefined),
		),
	];
}
