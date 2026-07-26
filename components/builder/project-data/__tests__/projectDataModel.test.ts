import { describe, expect, it } from "vitest";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_TABLE_BYTES,
} from "@/lib/lookup/constants";
import type {
	LookupColumn,
	LookupRevision,
	LookupRow,
	LookupRowValues,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import {
	captureRowEditBaseline,
	cellText,
	columnsEqual,
	conflictDeleteInput,
	conflictOverwriteInput,
	conflictSaveAsNewInput,
	createRevisionedTextDraft,
	discardRevisionedTextDraft,
	editRevisionedTextDraft,
	editRowDraftCellText,
	filterRows,
	formatLookupBytes,
	formatLookupCount,
	keepRevisionedTextDraft,
	reconcileConflictDraft,
	reconcileRevisionedTextDraft,
	reconcileRowDraft,
	replacementConflictVerdict,
	rowAdditionRefusal,
	rowDraftToValues,
	rowValuesEqual,
	rowValuesToDraft,
	rowWriteConflictVerdict,
	suggestWireName,
	tableCapacity,
} from "../projectDataModel";

const nameColumnId = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c001",
);
const codeColumnId = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c002",
);
const rowId = lookupRowIdSchema.parse("01912d68-783e-7000-8000-00000000d001");
const tableId = lookupTableIdSchema.parse(
	"01912d68-783e-7000-8000-00000000b001",
);
const decimalColumnId = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c003",
);
const dateColumnId = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c004",
);
const timeColumnId = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c005",
);
const datetimeColumnId = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c006",
);

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

const revision = (value: string) => value as LookupRevision;
const draft = (entries: Record<string, string | undefined>) =>
	Object.fromEntries(
		Object.entries(entries).map(([key, text]) => [key, { text }]),
	) as ReturnType<typeof rowValuesToDraft>;

function tableSnapshot(
	tableRevision: LookupRevision,
	currentRow: LookupRow,
): LookupTableSnapshot {
	return {
		projectId: "project-1",
		projectRevision: tableRevision,
		id: tableId,
		name: "Facilities",
		tag: "facilities",
		columns: [nameColumn, codeColumn],
		columnCount: 2,
		rows: [currentRow],
		rowCount: 1,
		dataBytes: 0,
		definitionRevision: tableRevision,
		rowsRevision: tableRevision,
		tableRevision,
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

describe("captureRowEditBaseline", () => {
	it("keeps the opened generation immutable across later snapshot changes", () => {
		const openedRow = row({ [nameColumnId]: "Kitgum" });
		const opened = tableSnapshot(revision("1"), openedRow);
		const baseline = captureRowEditBaseline(opened, openedRow);

		/* Simulate a realtime refresh replacing both row cells and definition.
		 * Save must still compare with generation 1, not silently adopt this. */
		opened.tableRevision = revision("2");
		openedRow.values[nameColumnId] = "Kitgum Health Centre";
		opened.columns[0] = { ...nameColumn, label: "Facility name" };

		expect(baseline).toEqual({
			tableRevision: revision("1"),
			row: row({ [nameColumnId]: "Kitgum" }),
			columns: [nameColumn, codeColumn],
		});
	});
});

describe("row conflict resolution inputs", () => {
	const resolution = {
		tableRevision: revision("9"),
		rowCount: 4,
	};
	const mine = values({ [nameColumnId]: "My draft" });

	it("writes Keep mine and Delete anyway against the reviewed generation", () => {
		expect(
			conflictOverwriteInput({
				tableId,
				rowId,
				draft: mine,
				resolution,
			}),
		).toEqual({
			tableId,
			expectedTableRevision: revision("9"),
			rowId,
			values: mine,
		});
		expect(conflictDeleteInput({ tableId, rowId, resolution })).toEqual({
			tableId,
			expectedTableRevision: revision("9"),
			rowId,
		});
	});

	it("appends a gone row draft at the exact reviewed row count", () => {
		expect(
			conflictSaveAsNewInput({
				tableId,
				draft: mine,
				resolution,
			}),
		).toEqual({
			tableId,
			expectedTableRevision: revision("9"),
			toIndex: 4,
			values: mine,
		});
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

describe("suggestWireName", () => {
	it("derives a legal identifier from a human label", () => {
		expect(suggestWireName("Facility name")).toBe("facility_name");
		expect(suggestWireName("  District / Region  ")).toBe("district_region");
	});

	it("keeps accented labels legible instead of dropping their letters", () => {
		expect(suggestWireName("Établissement")).toBe("etablissement");
	});

	it("never suggests a name the boundary would refuse", () => {
		// Must start with a letter or underscore…
		expect(suggestWireName("2024 total")).toBe("c_2024_total");
		// …and must not start with `xml`, which the wire rejects outright.
		expect(suggestWireName("XML source")).toBe("c_xml_source");
	});

	it("suggests nothing for a label with no usable characters", () => {
		expect(suggestWireName("   ")).toBe("");
		expect(suggestWireName("—")).toBe("");
	});
});

describe("rowDraftToValues", () => {
	const columns = [nameColumn, codeColumn];

	it("preserves empty and whitespace text while a missing numeric cell stays absent", () => {
		const result = rowDraftToValues(
			draft({ [nameColumnId]: "  ", [codeColumnId]: undefined }),
			columns,
		);
		expect(result).toEqual({
			ok: true,
			values: { [nameColumnId]: "  " },
		});
	});

	it("parses through the same validation the server will run", () => {
		const result = rowDraftToValues(
			draft({ [nameColumnId]: "Kitgum", [codeColumnId]: "42" }),
			columns,
		);
		expect(result).toEqual({
			ok: true,
			values: { [nameColumnId]: "Kitgum", [codeColumnId]: 42 },
		});
	});

	it("reports a per-cell reason rather than one failure for the row", () => {
		const result = rowDraftToValues(
			draft({
				[nameColumnId]: "Kitgum",
				[codeColumnId]: "not a number",
			}),
			columns,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.has(codeColumnId)).toBe(true);
		expect(result.errors.has(nameColumnId)).toBe(false);
	});

	it("accepts a typed clock and stores the wire's own spelling", () => {
		const timeColumn: LookupColumn = {
			id: codeColumnId,
			wireName: "opens",
			label: "Opens",
			dataType: "time",
		};
		const result = rowDraftToValues(draft({ [codeColumnId]: "2:30 PM" }), [
			timeColumn,
		]);
		expect(result).toEqual({
			ok: true,
			values: { [codeColumnId]: "14:30:00Z" },
		});
	});

	it("accepts fractional seconds when a visible clock is edited", () => {
		const timeColumn: LookupColumn = {
			id: codeColumnId,
			wireName: "opens",
			label: "Opens",
			dataType: "time",
		};
		expect(
			rowDraftToValues(draft({ [codeColumnId]: "14:30:05.125" }), [timeColumn]),
		).toEqual({
			ok: true,
			values: { [codeColumnId]: "14:30:05.125Z" },
		});
	});

	it("refuses a half-typed date and time instead of storing one", () => {
		const stampColumn: LookupColumn = {
			id: codeColumnId,
			wireName: "seen_at",
			label: "Seen at",
			dataType: "datetime",
		};
		const result = rowDraftToValues(draft({ [codeColumnId]: "2026-01-01" }), [
			stampColumn,
		]);
		expect(result.ok).toBe(false);
	});

	it("does not trim numeric text into a different value", () => {
		const result = rowDraftToValues(
			draft({ [nameColumnId]: "Kitgum", [codeColumnId]: " 42 " }),
			columns,
		);
		expect(result.ok).toBe(false);
	});
});

describe("rowValuesToDraft", () => {
	it("round-trips through the draft without inventing values", () => {
		const stored = values({ [nameColumnId]: "Kitgum" });
		const draft = rowValuesToDraft(stored, [nameColumn, codeColumn]);
		expect(draft[nameColumnId]).toEqual({ text: "Kitgum" });
		expect(draft[codeColumnId]).toEqual({ text: undefined });
		expect(rowDraftToValues(draft, [nameColumn, codeColumn])).toEqual({
			ok: true,
			values: stored,
		});
	});

	it("round-trips every stored type, including exact temporal offsets", () => {
		const allColumns: LookupColumn[] = [
			nameColumn,
			codeColumn,
			{
				id: decimalColumnId,
				wireName: "amount",
				label: "Amount",
				dataType: "decimal",
			},
			{
				id: dateColumnId,
				wireName: "day",
				label: "Day",
				dataType: "date",
			},
			{
				id: timeColumnId,
				wireName: "opens",
				label: "Opens",
				dataType: "time",
			},
			{
				id: datetimeColumnId,
				wireName: "seen_at",
				label: "Seen at",
				dataType: "datetime",
			},
		];
		const stored = values({
			[nameColumnId]: "",
			[codeColumnId]: 7,
			[decimalColumnId]: 1.25,
			[dateColumnId]: "2026-03-04",
			[timeColumnId]: "14:30:00.125+05:30",
			[datetimeColumnId]: "2026-03-04T08:10:11-0400",
		});

		expect(
			rowDraftToValues(rowValuesToDraft(stored, allColumns), allColumns),
		).toEqual({ ok: true, values: stored });
	});

	it("keeps a temporal cell's offset when its visible clock changes", () => {
		const timeColumn: LookupColumn = {
			id: codeColumnId,
			wireName: "opens",
			label: "Opens",
			dataType: "time",
		};
		const original = rowValuesToDraft(
			values({ [codeColumnId]: "14:30:00+05:30" }),
			[timeColumn],
		);
		const edited = {
			...original,
			[codeColumnId]: {
				...original[codeColumnId],
				text: "3:45 PM",
			},
		};

		expect(rowDraftToValues(edited, [timeColumn])).toEqual({
			ok: true,
			values: { [codeColumnId]: "15:45:00+05:30" },
		});
	});

	it("retains exact temporal source bytes after type-away then type-back", () => {
		const timeColumn: LookupColumn = {
			id: codeColumnId,
			wireName: "opens",
			label: "Opens",
			dataType: "time",
		};
		const original = rowValuesToDraft(
			values({ [codeColumnId]: "14:30:00.125+0530" }),
			[timeColumn],
		);
		const away = editRowDraftCellText(
			original[codeColumnId],
			"time",
			"3:45 PM",
		);
		const back = editRowDraftCellText(away, "time", "14:30:00.125");

		expect(rowDraftToValues({ [codeColumnId]: back }, [timeColumn])).toEqual({
			ok: true,
			values: { [codeColumnId]: "14:30:00.125+0530" },
		});
	});
});

describe("reconcileConflictDraft", () => {
	it("projects onto fresh columns and preserves removed values for review", () => {
		const renamedName = { ...nameColumn, label: "Facility" };
		const retypedCode = { ...codeColumn, dataType: "date" as const };
		const newColumn: LookupColumn = {
			id: dateColumnId,
			wireName: "district",
			label: "District",
			dataType: "text",
		};
		const reconciled = reconcileConflictDraft(
			values({
				[nameColumnId]: "  Kitgum\nHC  ",
				[codeColumnId]: 42,
				[timeColumnId]: "",
			}),
			[
				nameColumn,
				codeColumn,
				{
					id: timeColumnId,
					wireName: "old_note",
					label: "Old note",
					dataType: "text",
				},
			],
			[renamedName, retypedCode, newColumn],
		);

		expect(reconciled.draft[nameColumnId]).toEqual({
			text: "  Kitgum\nHC  ",
		});
		expect(reconciled.draft[codeColumnId]).toEqual({ text: "42" });
		expect(reconciled.draft[dateColumnId]).toEqual({ text: undefined });
		expect(reconciled.removed).toEqual([
			{
				column: {
					id: timeColumnId,
					wireName: "old_note",
					label: "Old note",
					dataType: "text",
				},
				value: { text: "" },
			},
		]);
		expect(
			rowDraftToValues(reconciled.draft, [renamedName, retypedCode, newColumn])
				.ok,
		).toBe(false);
	});

	it("keeps an unparsed raw draft when realtime removes its row first", () => {
		const result = reconcileRowDraft(
			draft({ [nameColumnId]: "  draft\n", [codeColumnId]: "not-a-number" }),
			[nameColumn, codeColumn],
			[nameColumn, codeColumn],
		);
		expect(result.draft).toEqual(
			draft({
				[nameColumnId]: "  draft\n",
				[codeColumnId]: "not-a-number",
			}),
		);
		expect(rowDraftToValues(result.draft, [nameColumn, codeColumn]).ok).toBe(
			false,
		);
	});
});

describe("revisioned text drafts", () => {
	it("reseeds a pristine draft from realtime state", () => {
		const draft = createRevisionedTextDraft("Facilities", revision("1"));
		expect(
			reconcileRevisionedTextDraft(draft, "Clinics", revision("2")),
		).toEqual(createRevisionedTextDraft("Clinics", revision("2")));
	});

	it("keeps a dirty draft and requires an explicit drift decision", () => {
		const dirty = editRevisionedTextDraft(
			createRevisionedTextDraft("Facilities", revision("1")),
			"My facilities",
		);
		const conflicted = reconcileRevisionedTextDraft(
			dirty,
			"Clinics",
			revision("2"),
		);
		expect(conflicted).toMatchObject({
			text: "My facilities",
			baseRevision: revision("1"),
			latestText: "Clinics",
			latestRevision: revision("2"),
			conflicted: true,
		});
		expect(keepRevisionedTextDraft(conflicted)).toMatchObject({
			text: "My facilities",
			baseRevision: revision("2"),
			conflicted: false,
		});
		expect(discardRevisionedTextDraft(conflicted)).toEqual(
			createRevisionedTextDraft("Clinics", revision("2")),
		);
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
