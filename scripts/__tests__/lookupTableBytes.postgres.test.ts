import { sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createLookupRow, createLookupTable } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";
import {
	repairLookupTableBytes,
	scanLookupTableBytes,
} from "../lib/lookupTableBytes";

const h = setupAppStateTestDb("lookup_table_bytes_");

const OWNER_A: LookupScope = {
	projectId: "bytes-project-a",
	actorId: "bytes-owner-a",
	role: "owner",
};
const OWNER_B: LookupScope = {
	projectId: "bytes-project-b",
	actorId: "bytes-owner-b",
	role: "owner",
};

beforeEach(async () => {
	await h.seedProjectMember(OWNER_A.actorId, OWNER_A.projectId, "owner");
	await h.seedProjectMember(OWNER_B.actorId, OWNER_B.projectId, "owner");
});

async function tableWithRows(scope: LookupScope, tag: string) {
	const table = await createLookupTable(scope, {
		name: tag,
		tag,
		columns: [{ wireName: "name", label: "Name", dataType: "text" }],
	});
	const column = table.columns[0].id;
	const first = await createLookupRow(scope, {
		tableId: table.id,
		expectedTableRevision: table.tableRevision,
		toIndex: 0,
		values: { [column]: "north" },
	});
	await createLookupRow(scope, {
		tableId: table.id,
		expectedTableRevision: first.tableRevision,
		toIndex: 1,
		values: { [column]: "south" },
	});
	return table.id;
}

async function storedBytes(scope: LookupScope, tableId: string) {
	const row = await h
		.db()
		.selectFrom("lookup_tables")
		.select("data_bytes")
		.where("project_id", "=", scope.projectId)
		.where("id", "=", tableId)
		.executeTakeFirstOrThrow();
	return row.data_bytes;
}

describe("lookup table byte totals", () => {
	it("finds and repairs the total the previous revision concatenated, and nothing else", async () => {
		const damaged = await tableWithRows(OWNER_A, "regions");
		const intact = await tableWithRows(OWNER_B, "regions");
		const correct = await storedBytes(OWNER_A, damaged);
		const intactBytes = await storedBytes(OWNER_B, intact);
		expect(await scanLookupTableBytes(h.db())).toEqual({
			inlineTables: 2,
			mismatched: 0,
		});

		/* The previous revision's add-row: the driver hands back the widened
		 * int8 as a string, so `data_bytes + value_bytes` concatenates. */
		const previousRevisionTotal = `${correct}` + 120;
		await sql`UPDATE lookup_tables SET data_bytes = ${previousRevisionTotal}
			WHERE project_id = ${OWNER_A.projectId} AND id = ${damaged}::uuid`.execute(
			h.db(),
		);
		expect(Number(await storedBytes(OWNER_A, damaged))).toBe(
			Number(`${correct}120`),
		);

		expect(await scanLookupTableBytes(h.db())).toEqual({
			inlineTables: 2,
			mismatched: 1,
		});
		expect(await repairLookupTableBytes(h.db())).toBe(1);
		expect(await scanLookupTableBytes(h.db())).toEqual({
			inlineTables: 2,
			mismatched: 0,
		});
		expect(await storedBytes(OWNER_A, damaged)).toBe(correct);
		expect(await storedBytes(OWNER_B, intact)).toBe(intactBytes);
		expect(await repairLookupTableBytes(h.db())).toBe(0);
	});
});
