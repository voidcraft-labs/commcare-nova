/**
 * Stored lookup cell → fixture text.
 *
 * S01 owns storage coercion; this boundary only projects the stored value to
 * its wire lexical form and may not reinterpret it. Text and temporal cells
 * are stored as their canonical strings and pass through byte-identically.
 * Int and decimal cells are stored as JS numbers; their wire form is the
 * canonical JS number-to-string spelling, which for the stored canonical
 * values equals the JSON-number serialization. A missing cell and a stored
 * empty text cell both project to blank text — the wire emits every defined
 * column, so absence is only distinguishable in storage.
 */

import type { LookupCellValue, LookupDataType } from "@/lib/lookup/types";

export function lookupFixtureCellText(
	dataType: LookupDataType,
	value: LookupCellValue | undefined,
): string {
	if (value === undefined) return "";
	switch (dataType) {
		case "text":
		case "date":
		case "time":
		case "datetime": {
			if (typeof value !== "string") {
				throw new Error(
					`lookupFixtureCellText: a '${dataType}' cell holds a stored number, which the storage layer never writes for that type. The definitions and rows in this snapshot disagree — this is a reader bug, not an authoring state.`,
				);
			}
			return value;
		}
		case "int":
		case "decimal": {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error(
					`lookupFixtureCellText: a '${dataType}' cell holds a non-numeric stored value, which the storage layer never writes for that type. The definitions and rows in this snapshot disagree — this is a reader bug, not an authoring state.`,
				);
			}
			return String(value);
		}
		default: {
			const _exhaustive: never = dataType;
			throw new Error(
				`lookupFixtureCellText: unhandled data type ${String(_exhaustive)}`,
			);
		}
	}
}
