/**
 * What the five case-list steps read of the stored document: each menu's
 * list, its columns, and the names a notice line gives a menu and a column.
 * The steps read the raw rows and write the raw rows; only
 * `sort-property-ownership` reads the order plan, through `typedView`.
 */

import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { asUuid, type BlueprintDoc, type PersistableDoc } from "@/lib/domain";
import {
	type JsonRecord,
	type RawDocument,
	rawDocumentAssembly,
} from "../oldShape";
import type { DocumentChange } from "../transform";
import { isRecord, rawText } from "./relativePaths";

/** One menu's stored list, as the steps walk it. */
export interface RawCaseList {
	readonly moduleUuid: string;
	readonly module: JsonRecord;
	readonly config: JsonRecord;
	/** The stored columns, in stored order, each a writable record. */
	readonly columns: readonly JsonRecord[];
	/** Whether the list has a tile layout. */
	readonly tiled: boolean;
}

/** Every menu's list, in menu order; a menu with no list is left out. */
export function rawCaseLists(document: RawDocument): RawCaseList[] {
	return document.moduleOrder.flatMap((moduleUuid) => {
		const module = document.modules[moduleUuid];
		const config = module?.caseListConfig;
		if (module === undefined || !isRecord(config)) return [];
		const columns = Array.isArray(config.columns)
			? config.columns.filter(isRecord)
			: [];
		return [
			{
				moduleUuid,
				module,
				config,
				columns,
				tiled: config.tile !== undefined && config.tile !== null,
			},
		];
	});
}

/** The menu's name, as a notice line names it. */
export function menuName(list: RawCaseList): string {
	return rawText(list.module.name);
}

/**
 * A column's name in a notice line: its header, or where it has none "a
 * calculation" for a calculated column and the property name for any other,
 * as the validator labels a column
 * (`lib/commcare/validator/rules/case-list/shared.ts::caseListColumnLabel`).
 */
export function columnName(column: JsonRecord): string {
	const header = rawText(column.header).trim();
	if (header.length > 0) return header;
	return column.kind === "calculated" ? "a calculation" : rawText(column.field);
}

/** A notice entity naming one stored column. */
export function columnEntity(column: JsonRecord): DocumentChange["entity"] {
	return {
		type: "caseListColumn",
		uuid: asUuid(rawText(column.uuid)),
		nameAtMigration: columnName(column),
	};
}

/** A notice entity naming one menu. */
export function menuEntity(list: RawCaseList): DocumentChange["entity"] {
	return {
		type: "module",
		uuid: asUuid(list.moduleUuid),
		nameAtMigration: menuName(list),
	};
}

/** The writable view of a stored record. */
export function writableRecord(record: JsonRecord): Record<string, unknown> {
	return record as unknown as Record<string, unknown>;
}

/**
 * The document as the order plan reads it. The plan's readers take a
 * hydrated `BlueprintDoc`, and no schema reads a raw document, so this is the
 * assembled rows hydrated as they stand. The steps that run before
 * `sort-property-ownership` have written every slot the plan reads in the
 * tree's shape; what is left for later steps (a tile cell's presentation
 * slots, the app's settings) is nothing the plan reads.
 */
export function typedView(document: RawDocument, appId: string): BlueprintDoc {
	return hydratePersistedBlueprint(
		rawDocumentAssembly(appId, document) as unknown as PersistableDoc,
	);
}
