// Live-Postgres coverage for the compile boundary's definitions-plus-rows
// reader. `getLookupFixtureData` must return every requested table's
// definition AND complete ordered row body from one REPEATABLE READ
// snapshot — the compile path may not loop `getLookupTable`, whose
// per-call snapshots could mix generations.

import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import {
	createLookupRow,
	createLookupTable,
	getLookupFixtureData,
	getLookupManifest,
} from "../service";
import type { LookupRowValues, LookupScope } from "../types";

setupAppStateTestDb("lookup_fixture_");

const OWNER_A: LookupScope = {
	projectId: "project-a",
	actorId: "owner-a",
	role: "owner",
};
const OWNER_B: LookupScope = {
	projectId: "project-b",
	actorId: "owner-b",
	role: "owner",
};

const MISSING_TABLE_ID = lookupTableIdSchema.parse(
	"018f0f43-7b7c-7abc-8def-0123456789ab",
);

describe("getLookupFixtureData", () => {
	it("returns definitions plus complete authored-order rows for several tables in one snapshot", async () => {
		const regions = await createLookupTable(OWNER_A, {
			name: "Regions",
			tag: "regions",
			columns: [
				{ wireName: "value", label: "Value", dataType: "text" },
				{ wireName: "pop", label: "Population", dataType: "int" },
			],
		});
		const statuses = await createLookupTable(OWNER_A, {
			name: "Statuses",
			tag: "statuses",
			columns: [{ wireName: "code", label: "Code", dataType: "text" }],
		});
		const [valueColumn, popColumn] = regions.columns;
		const codeColumn = statuses.columns[0];

		const first = await createLookupRow(OWNER_A, {
			tableId: regions.id,
			expectedTableRevision: regions.tableRevision,
			toIndex: 0,
			values: {
				[valueColumn.id]: "north",
				[popColumn.id]: 120,
			} as LookupRowValues,
		});
		const second = await createLookupRow(OWNER_A, {
			tableId: regions.id,
			expectedTableRevision: first.tableRevision,
			toIndex: 1,
			values: { [valueColumn.id]: "south" } as LookupRowValues,
		});
		/* Insert at the front so authored order diverges from insertion order:
		 * the reader must sort by `(order_key, id)`, not creation time. */
		const inserted = await createLookupRow(OWNER_A, {
			tableId: regions.id,
			expectedTableRevision: second.tableRevision,
			toIndex: 0,
			values: {
				[valueColumn.id]: "west",
				[popColumn.id]: -5,
			} as LookupRowValues,
		});

		const snapshot = await getLookupFixtureData(OWNER_A, [
			statuses.id,
			regions.id,
		]);

		expect(snapshot.projectId).toBe(OWNER_A.projectId);
		expect(snapshot.definitions.map((table) => table.tag).sort()).toEqual([
			"regions",
			"statuses",
		]);
		const manifest = await getLookupManifest(OWNER_A);
		expect(snapshot.projectRevision).toBe(manifest.projectRevision);

		const regionRows = snapshot.rowsByTable.get(regions.id);
		expect(regionRows?.map((row) => row.id)).toEqual([
			inserted.rowId,
			first.rowId,
			second.rowId,
		]);
		expect(regionRows?.map((row) => row.values[valueColumn.id])).toEqual([
			"west",
			"north",
			"south",
		]);
		/* Stored numbers stay numbers; a missing cell stays absent. */
		expect(regionRows?.[0].values[popColumn.id]).toBe(-5);
		expect(regionRows?.[2].values[popColumn.id]).toBeUndefined();

		const statusRows = snapshot.rowsByTable.get(statuses.id);
		expect(statusRows).toEqual([]);
		expect(codeColumn.wireName).toBe("code");
	});

	it("treats missing and foreign requested ids identically: absent from both axes", async () => {
		const local = await createLookupTable(OWNER_A, {
			name: "Local",
			tag: "local_only",
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		});
		const foreign = await createLookupTable(OWNER_B, {
			name: "Foreign",
			tag: "foreign_only",
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		});

		const snapshot = await getLookupFixtureData(OWNER_A, [
			local.id,
			foreign.id,
			MISSING_TABLE_ID,
		]);

		expect(snapshot.definitions.map((table) => table.id)).toEqual([local.id]);
		expect([...snapshot.rowsByTable.keys()]).toEqual([local.id]);
		expect(snapshot.rowsByTable.get(foreign.id)).toBeUndefined();
		expect(snapshot.rowsByTable.get(MISSING_TABLE_ID)).toBeUndefined();
	});

	it("reads the Project clock even for the empty request", async () => {
		const snapshot = await getLookupFixtureData(OWNER_A, []);
		expect(snapshot.definitions).toEqual([]);
		expect(snapshot.rowsByTable.size).toBe(0);
		const manifest = await getLookupManifest(OWNER_A);
		expect(snapshot.projectRevision).toBe(manifest.projectRevision);
	});
});
