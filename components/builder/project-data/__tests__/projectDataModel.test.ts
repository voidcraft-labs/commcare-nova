import { describe, expect, it } from "vitest";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
} from "@/lib/domain/lookupIds";
import {
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_TABLE_BYTES,
} from "@/lib/lookup/constants";
import type {
	LookupColumn,
	LookupRow,
	LookupRowValues,
} from "@/lib/lookup/types";
import {
	cellText,
	columnsEqual,
	filterRows,
	formatLookupBytes,
	formatLookupCount,
	replacementConflictVerdict,
	rowAdditionRefusal,
	rowValuesEqual,
	rowWriteConflictVerdict,
	tableCapacity,
} from "../projectDataModel";

const nameColumnId = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c001",
);
const codeColumnId = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c002",
);
const rowId = lookupRowIdSchema.parse("01912d68-783e-7000-8000-00000000d001");

const nameColumn: LookupColumn = {
	id: nameColumnId,
	wireName: "name",
	label: "Name",
	dataType: "text",
};
const codeColumn: LookupColumn = {
	id: codeColumnId,
	wireName: "code",
	label: "Code",
	dataType: "int",
};

function values(entries: Record<string, string | number>): LookupRowValues {
	return entries as LookupRowValues;
}

function row(entries: Record<string, string | number>): LookupRow {
	return {
		id: rowId,
		values: values(entries),
		valueBytes: 0,
		createdBy: "u",
		updatedBy: "u",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("formatLookupBytes", () => {
	it("reports bytes exactly and larger sizes in binary units", () => {
		expect(formatLookupBytes(0)).toBe("0 bytes");
		expect(formatLookupBytes(1)).toBe("1 byte");
		expect(formatLookupBytes(1023)).toBe("1023 bytes");
		expect(formatLookupBytes(1024)).toBe("1 KB");
		expect(formatLookupBytes(1536)).toBe("1.5 KB");
	});

	it("prints the table byte cap as the round number the copy promises", () => {
		// A refusal that says "8.4 MB is over the 8 MB limit" reads as a bug.
		expect(formatLookupBytes(LOOKUP_MAX_TABLE_BYTES)).toBe("8 MB");
	});
});

describe("formatLookupCount", () => {
	it("agrees with its noun", () => {
		expect(formatLookupCount(0, "row")).toBe("0 rows");
		expect(formatLookupCount(1, "row")).toBe("1 row");
		expect(formatLookupCount(2, "column")).toBe("2 columns");
	});
});

describe("tableCapacity", () => {
	it("takes the binding cap, whichever it is", () => {
		const byRows = tableCapacity({
			rowCount: LOOKUP_MAX_ROWS / 2,
			dataBytes: 0,
		});
		expect(byRows.fullness).toBeCloseTo(0.5);
		expect(byRows.full).toBe(false);

		const byBytes = tableCapacity({
			rowCount: 1,
			dataBytes: LOOKUP_MAX_TABLE_BYTES,
		});
		expect(byBytes.fullness).toBe(1);
		expect(byBytes.full).toBe(true);
	});
});

describe("rowAdditionRefusal", () => {
	it("stays silent while the table has room", () => {
		expect(
			rowAdditionRefusal(tableCapacity({ rowCount: 3, dataBytes: 40 })),
		).toBe(undefined);
	});

	it("names the row limit that stopped the write", () => {
		const refusal = rowAdditionRefusal(
			tableCapacity({ rowCount: LOOKUP_MAX_ROWS, dataBytes: 10 }),
		);
		expect(refusal).toContain("5,000 rows");
	});

	it("names the MEASURED size, not just the limit, when bytes are the cap", () => {
		const refusal = rowAdditionRefusal(
			tableCapacity({ rowCount: 2, dataBytes: LOOKUP_MAX_TABLE_BYTES }),
		);
		expect(refusal).toContain("8 MB");
		// Both halves of the sentence are present: what it holds AND the ceiling.
		expect(refusal).toMatch(/holds 8 MB.*limit of 8 MB/);
	});
});

describe("cellText", () => {
	it("distinguishes a missing cell from an empty one", () => {
		expect(cellText(values({}), nameColumn)).toBe(undefined);
		expect(cellText(values({ [nameColumnId]: "" }), nameColumn)).toBe("");
	});

	it("renders a stored number as its text", () => {
		expect(cellText(values({ [codeColumnId]: 7 }), codeColumn)).toBe("7");
	});
});

describe("filterRows", () => {
	const rows = [
		{ values: values({ [nameColumnId]: "Kitgum Clinic", [codeColumnId]: 11 }) },
		{ values: values({ [nameColumnId]: "Gulu Hospital", [codeColumnId]: 22 }) },
		{ values: values({}) },
	];
	const columns = [nameColumn, codeColumn];

	it("returns everything for an empty or whitespace query", () => {
		expect(filterRows(rows, columns, "")).toBe(rows);
		expect(filterRows(rows, columns, "   ")).toBe(rows);
	});

	it("matches the text the grid shows, case-insensitively, across columns", () => {
		expect(filterRows(rows, columns, "kitgum")).toHaveLength(1);
		expect(filterRows(rows, columns, "22")).toHaveLength(1);
	});

	it("never matches a missing cell against the empty string", () => {
		// The blank row would match "" under a naive coercion, which would make
		// every query with an unmatched column return every empty row.
		expect(filterRows(rows, columns, "x")).toHaveLength(0);
	});
});

describe("rowValuesEqual", () => {
	it("ignores key order and compares by column identity", () => {
		expect(
			rowValuesEqual(
				values({ [nameColumnId]: "a", [codeColumnId]: 1 }),
				values({ [codeColumnId]: 1, [nameColumnId]: "a" }),
			),
		).toBe(true);
	});

	it("separates a missing cell from a stored empty one", () => {
		expect(rowValuesEqual(values({}), values({ [nameColumnId]: "" }))).toBe(
			false,
		);
	});
});

describe("rowWriteConflictVerdict", () => {
	const baseline = values({ [nameColumnId]: "Kitgum" });

	it("retries when the drift did not touch this row", () => {
		expect(
			rowWriteConflictVerdict({
				baseline,
				current: row({ [nameColumnId]: "Kitgum" }),
				columnsChanged: false,
			}),
		).toEqual({ kind: "retry" });
	});

	it("asks when this row changed underneath — never overwriting silently", () => {
		expect(
			rowWriteConflictVerdict({
				baseline,
				current: row({ [nameColumnId]: "Kitgum Health Centre" }),
				columnsChanged: false,
			}),
		).toEqual({ kind: "ask", reason: "row-changed" });
	});

	it("asks when the definition moved, even if the row's cells did not", () => {
		// A retype or a removed column changes what the draft MEANS, so an
		// unchanged-looking row is not proof the edit is still the same edit.
		expect(
			rowWriteConflictVerdict({
				baseline,
				current: row({ [nameColumnId]: "Kitgum" }),
				columnsChanged: true,
			}),
		).toEqual({ kind: "ask", reason: "columns-changed" });
	});

	it("reports a vanished row as gone rather than asking about nothing", () => {
		expect(
			rowWriteConflictVerdict({
				baseline,
				current: undefined,
				columnsChanged: false,
			}),
		).toEqual({ kind: "gone" });
	});
});

describe("replacementConflictVerdict", () => {
	it("never retries — a replacement over changed data is the destructive case", () => {
		expect(replacementConflictVerdict()).toEqual({
			kind: "ask",
			reason: "table-replaced",
		});
	});
});

describe("columnsEqual", () => {
	it("compares identity, projection, and order together", () => {
		expect(
			columnsEqual([nameColumn, codeColumn], [nameColumn, codeColumn]),
		).toBe(true);
		expect(
			columnsEqual([nameColumn, codeColumn], [codeColumn, nameColumn]),
		).toBe(false);
		expect(
			columnsEqual(
				[nameColumn],
				[{ ...nameColumn, dataType: "int" satisfies LookupColumn["dataType"] }],
			),
		).toBe(false);
	});
});
