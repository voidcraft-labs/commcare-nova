import { describe, expect, it } from "vitest";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import type { LookupRevision, LookupTableSnapshot } from "@/lib/lookup/types";
import {
	buildLookupCsvSelection,
	currentLookupCsvTable,
	lookupCsvSelectionIsCurrent,
	shouldCommitLookupCsvRead,
} from "../csvImportModel";

const tableId = lookupTableIdSchema.parse(
	"01912d68-783e-7000-8000-00000000a001",
);
const otherTableId = lookupTableIdSchema.parse(
	"01912d68-783e-7000-8000-00000000a002",
);
const columnId = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c001",
);
const revision = (value: string) => value as LookupRevision;

function table(
	overrides: Partial<LookupTableSnapshot> = {},
): LookupTableSnapshot {
	return {
		projectId: "project-a",
		projectRevision: revision("4"),
		id: tableId,
		name: "Facilities",
		tag: "facilities",
		definitionRevision: revision("3"),
		rowsRevision: revision("4"),
		tableRevision: revision("4"),
		columns: [
			{
				id: columnId,
				wireName: "name",
				label: "Name",
				dataType: "text",
			},
		],
		columnCount: 1,
		rows: [],
		rowCount: 7,
		dataBytes: 0,
		createdBy: "author",
		updatedBy: "author",
		createdAt: "2026-07-26T00:00:00.000Z",
		updatedAt: "2026-07-26T00:00:00.000Z",
		...overrides,
	};
}

const file = {
	name: "facilities.csv",
	async arrayBuffer() {
		return new TextEncoder().encode("name\nKitgum\nGulu\n").buffer;
	},
};

describe("CSV import selection", () => {
	it("keeps a direct fresh review only in the exact Project/table context", () => {
		const rendered = table({ tableRevision: revision("4") });
		const reviewed = table({ tableRevision: revision("5"), rowCount: 9 });
		expect(currentLookupCsvTable(rendered, reviewed, "project-a")).toBe(
			reviewed,
		);
		expect(
			currentLookupCsvTable(
				{ ...rendered, tableRevision: revision("6") },
				reviewed,
				"project-a",
			).tableRevision,
		).toBe(revision("6"));
		expect(
			currentLookupCsvTable(
				rendered,
				{ ...reviewed, projectId: "project-b" },
				"project-a",
			),
		).toBe(rendered);
		expect(
			currentLookupCsvTable(
				rendered,
				{ ...reviewed, id: otherTableId },
				"project-a",
			),
		).toBe(rendered);
	});

	it("freezes bytes, file, row count, schema, Project, and revisions together", () => {
		const source = new TextEncoder().encode("name\nKitgum\nGulu\n");
		const result = buildLookupCsvSelection({
			generation: 2,
			projectId: "project-a",
			table: table(),
			file,
			bytes: source,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		source[0] = 0;
		expect(result.selection).toMatchObject({
			generation: 2,
			projectId: "project-a",
			tableId,
			file,
			fileName: "facilities.csv",
			rowCount: 2,
			definitionRevision: revision("3"),
			tableRevision: revision("4"),
			replacedRowCount: 7,
		});
		expect(new TextDecoder().decode(result.selection.bytes)).toBe(
			"name\nKitgum\nGulu\n",
		);
		expect(result.selection.schema).toEqual(table().columns);
	});

	it("drops an out-of-order file read settle", () => {
		expect(shouldCommitLookupCsvRead(1, 2)).toBe(false);
		expect(shouldCommitLookupCsvRead(2, 2)).toBe(true);
	});

	it("requires reconfirmation for Project, schema, or row-generation drift", () => {
		const result = buildLookupCsvSelection({
			generation: 1,
			projectId: "project-a",
			table: table(),
			file,
			bytes: new TextEncoder().encode("name\nKitgum\n"),
		});
		if (!result.ok) throw new Error("expected checked CSV");
		const selection = result.selection;

		expect(lookupCsvSelectionIsCurrent(selection, "project-a", table())).toBe(
			true,
		);
		expect(lookupCsvSelectionIsCurrent(selection, "project-b", table())).toBe(
			false,
		);
		expect(
			lookupCsvSelectionIsCurrent(
				selection,
				"project-a",
				table({
					rowsRevision: revision("5"),
					tableRevision: revision("5"),
					rowCount: 8,
				}),
			),
		).toBe(false);
		expect(
			lookupCsvSelectionIsCurrent(
				selection,
				"project-a",
				table({
					definitionRevision: revision("5"),
					tableRevision: revision("5"),
					columns: [
						{
							id: columnId,
							wireName: "facility_name",
							label: "Name",
							dataType: "text",
						},
					],
				}),
			),
		).toBe(false);
	});

	it("rechecks the same bytes against the latest schema before a new decision", () => {
		const first = buildLookupCsvSelection({
			generation: 1,
			projectId: "project-a",
			table: table(),
			file,
			bytes: new TextEncoder().encode("name\nKitgum\n"),
		});
		if (!first.ok) throw new Error("expected checked CSV");
		const changed = table({
			definitionRevision: revision("5"),
			tableRevision: revision("5"),
			columns: [
				{
					id: columnId,
					wireName: "facility_name",
					label: "Name",
					dataType: "text",
				},
			],
		});
		const reviewed = buildLookupCsvSelection({
			generation: first.selection.generation,
			projectId: "project-a",
			table: changed,
			file: first.selection.file,
			bytes: first.selection.bytes,
		});

		expect(reviewed).toMatchObject({
			ok: false,
			failure: { code: "invalid_csv" },
		});
		/* A failed review is a verdict about the new schema, not permission to
		 * mutate or forget the already-copied file draft. */
		expect(first.selection.file).toBe(file);
		expect(new TextDecoder().decode(first.selection.bytes)).toBe(
			"name\nKitgum\n",
		);
	});
});
