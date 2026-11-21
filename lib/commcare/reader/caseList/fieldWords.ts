/**
 * The word each case list column's source keeps its property under, where CommCare HQ names the
 * property by two (`suite/wire.ts::columnFieldWordOf`: the case's name, its opening date and its
 * external id). Both words read as one property, so the reading's document holds the property
 * alone; the word is where HQ keeps the column, which names the column's app strings
 * (`id_strings.py::detail_column_header_locale`), so the reading carries it beside the document
 * (`ReadMenuAndFormIdentities.columnFieldWords`) as it carries a form's id.
 */

import type { BlueprintDoc } from "@/lib/domain";
import { columnFieldWordOf } from "../../suite/wire";
import type { ColumnFieldWordRow, ColumnScreen } from "../../wireIdentity";
import type { ReadContext } from "../context";
import { isJsonObject } from "../jsonCursor";
import { caseListReadings } from "./details";

/**
 * Every column `doc` holds that a menu's stored details keep over one of the three properties,
 * with the word each detail's column stores, by screen, in menu and join order. A field written
 * as an expression (`useXpathExpression`) names no word.
 */
export function columnFieldWordsRead(
	ctx: ReadContext,
	doc: BlueprintDoc,
): readonly ColumnFieldWordRow[] {
	const rows: ColumnFieldWordRow[] = [];
	for (const reading of caseListReadings(ctx).values()) {
		const held = new Set(
			(doc.modules[reading.module.uuid]?.caseListConfig?.columns ?? []).map(
				(column) => column.uuid,
			),
		);
		const stored = {
			short: reading.short.peek("columns"),
			long: reading.long.peek("columns"),
		};
		const wordAt = (screen: ColumnScreen, index: number | undefined) => {
			if (index === undefined) return undefined;
			const columns = stored[screen];
			const column = Array.isArray(columns) ? columns[index] : undefined;
			if (
				!isJsonObject(column) ||
				column.useXpathExpression === true ||
				typeof column.field !== "string"
			)
				return undefined;
			return columnFieldWordOf(column.field)?.word;
		};
		reading.joined.columns.forEach((column, index) => {
			const uuid = reading.uuids[index];
			if (uuid === undefined || !held.has(uuid)) return;
			if (column.carrier === true) return;
			for (const screen of ["short", "long"] as const) {
				const word = wordAt(screen, column[screen]);
				if (word !== undefined) rows.push({ columnUuid: uuid, screen, word });
			}
		});
	}
	return rows;
}
