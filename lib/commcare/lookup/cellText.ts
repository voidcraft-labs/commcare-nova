/**
 * Stored lookup cell → fixture text.
 *
 * S01 owns storage coercion; this boundary only projects the stored value to
 * its wire lexical form and may not reinterpret it. Text and temporal cells
 * are stored as their canonical strings and pass through byte-identically.
 * Int and decimal cells are stored as JS numbers; their wire form is the
 * exponent-free plain-decimal spelling `formatNumeric` produces — the same
 * spelling every predicate literal emits. `String(1e-7)` would emit `"1e-7"`,
 * which CommCare Core's numeric coercion rejects as NaN
 * (`FunctionUtils.checkForInvalidNumericOrDatestringCharacters` admits only
 * `[-.0-9]`), so a cell and its own literal would silently never compare
 * equal. A missing cell and a stored empty text cell both project to blank
 * text — the wire emits every defined column, so absence is only
 * distinguishable in storage.
 */

import type { LookupCellValue, LookupDataType } from "@/lib/lookup/types";
import { formatNumeric } from "../predicate/stringQuoting";

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
			return formatNumeric(value);
		}
		default: {
			const _exhaustive: never = dataType;
			throw new Error(
				`lookupFixtureCellText: unhandled data type ${String(_exhaustive)}`,
			);
		}
	}
}
