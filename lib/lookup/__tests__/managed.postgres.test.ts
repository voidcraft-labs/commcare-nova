// Live-Postgres coverage for lookup tables CommCare HQ manages: the refusal
// every writer meets, the create arm and the refresh arm.

import { createHash } from "node:crypto";
import { sql } from "kysely";
import { Client, type Notification } from "pg";
import { v7 } from "uuid";
import { describe, expect, it, vi } from "vitest";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { LOOKUP_STREAM_CHANNEL } from "@/lib/db/pg";
import {
	type LookupColumnId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { applyLookupAuthoringBatchInTransaction } from "../authoringBatch";
import { LookupError } from "../errors";
import {
	createManagedLookupTablesInTransaction,
	type ManagedLookupContent,
	type ManagedOriginWrite,
	refreshManagedLookupTableInTransaction,
} from "../managed";
import {
	applyLookupSchemaGovernance,
	LookupSchemaGovernanceError,
} from "../schemaGovernance";
import {
	addLookupColumn,
	createLookupRow,
	createLookupTable,
	deleteLookupRow,
	getLookupFixtureData,
	getLookupManifest,
	getLookupTable,
	moveLookupColumn,
	moveLookupRow,
	replaceLookupRows,
	updateLookupColumnLabel,
	updateLookupColumnWireName,
	updateLookupRow,
	updateLookupTableName,
	updateLookupTableTag,
} from "../service";
import type {
	LookupAuthoringExistingTable,
	LookupRowValues,
	LookupScope,
	LookupTableSnapshot,
} from "../types";

/* Three connections: a held hand-back, an author's write waiting at its lock,
 * and the observer that sees it wait. */
const h = setupAppStateTestDb("lookup_managed_", { poolMax: 3 });

const SCOPE: LookupScope = {
	projectId: "project-managed",
	actorId: "managed-writer",
	role: "owner",
};
const DOMAIN = "district-health";
const AT = new Date("2026-11-01T09:30:00.000Z");
const LATER = new Date("2026-11-02T10:00:00.000Z");

const FIELDS = ["name", "code", "count"] as const;
const CONTENT: ManagedLookupContent = {
	fields: FIELDS,
	rows: [
		{ name: "Alpha", code: "001" },
		{ name: "Beta", code: "002" },
	],
};

function canonicalOf(
	fields: readonly string[],
	rows: ManagedLookupContent["rows"],
	remoteId = "hq-table-1",
): Readonly<Record<string, unknown>> {
	const content = {
		fields: fields.map((name) => ({ name, properties: [] })),
		rowCount: rows.length,
		rows,
	};
	return {
		remoteId,
		...content,
		digest: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
	};
}

function originFor(
	content: ManagedLookupContent,
	remoteId = "hq-table-1",
): ManagedOriginWrite {
	return {
		server: "production",
		domain: DOMAIN,
		remoteId,
		canonical: canonicalOf(content.fields, content.rows, remoteId),
	};
}

function bindingFor(tag: string, fields: readonly string[]) {
	return {
		tag,
		tableId: lookupTableIdSchema.parse(v7()),
		columns: Object.fromEntries(
			fields.map((field) => [field, lookupColumnIdSchema.parse(v7())]),
		),
	};
}

async function createManaged(
	tag = "districts",
	content: ManagedLookupContent = CONTENT,
): Promise<LookupTableSnapshot> {
	const binding = bindingFor(tag, content.fields);
	await h
		.db()
		.transaction()
		.execute((tx) =>
			createManagedLookupTablesInTransaction(
				tx,
				SCOPE,
				[{ binding, name: tag, content, origin: originFor(content) }],
				AT,
			),
		);
	return getLookupTable(SCOPE, binding.tableId);
}

async function takeOver(tableId: LookupTableId): Promise<void> {
	await h
		.db()
		.updateTable("lookup_tables")
		.set({ hq_taken_over_at: LATER, hq_taken_over_by: SCOPE.actorId })
		.where("project_id", "=", SCOPE.projectId)
		.where("id", "=", tableId)
		.execute();
}

function columnId(
	table: LookupTableSnapshot,
	wireName: string,
): LookupColumnId {
	const column = table.columns.find((item) => item.wireName === wireName);
	if (column === undefined) throw new Error(`No column ${wireName}`);
	return column.id;
}

function values(
	entries: readonly (readonly [LookupColumnId, string | number])[],
): LookupRowValues {
	const result: LookupRowValues = {};
	for (const [id, value] of entries) result[id] = value;
	return result;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("Expected the call to be refused.");
}

function inBatch(
	update: Omit<
		LookupAuthoringExistingTable,
		"tableId" | "expectedTableRevision"
	>,
) {
	return (table: LookupTableSnapshot) =>
		h
			.db()
			.transaction()
			.execute((tx) =>
				applyLookupAuthoringBatchInTransaction(tx, SCOPE, {
					updateTables: [
						{
							tableId: table.id,
							expectedTableRevision: table.tableRevision,
							...update,
						},
					],
				}),
			);
}

/** One entry per writer path an author reaches a table by. */
function authorWrites(): readonly {
	readonly label: string;
	readonly governance?: true;
	readonly run: (table: LookupTableSnapshot) => Promise<unknown>;
}[] {
	const revision = (table: LookupTableSnapshot) => ({
		tableId: table.id,
		expectedTableRevision: table.tableRevision,
	});
	return [
		{
			label: "updateLookupTableName",
			run: (t) =>
				updateLookupTableName(SCOPE, { ...revision(t), name: "Renamed" }),
		},
		{
			label: "updateLookupTableTag",
			run: (t) =>
				updateLookupTableTag(SCOPE, {
					...revision(t),
					tag: `${t.tag}_renamed`,
				}),
		},
		{
			label: "addLookupColumn",
			run: (t) =>
				addLookupColumn(SCOPE, {
					...revision(t),
					column: { wireName: "extra", label: "Extra", dataType: "text" },
				}),
		},
		{
			label: "updateLookupColumnLabel",
			run: (t) =>
				updateLookupColumnLabel(SCOPE, {
					...revision(t),
					columnId: columnId(t, "name"),
					label: "District name",
				}),
		},
		{
			label: "updateLookupColumnWireName",
			run: (t) =>
				updateLookupColumnWireName(SCOPE, {
					...revision(t),
					columnId: columnId(t, "name"),
					wireName: "district_name",
				}),
		},
		{
			label: "moveLookupColumn",
			run: (t) =>
				moveLookupColumn(SCOPE, {
					...revision(t),
					columnId: columnId(t, "name"),
					toIndex: 1,
				}),
		},
		{
			label: "createLookupRow",
			run: (t) =>
				createLookupRow(SCOPE, {
					...revision(t),
					toIndex: 0,
					values: values([[columnId(t, "name"), "Gamma"]]),
				}),
		},
		{
			label: "updateLookupRow",
			run: (t) =>
				updateLookupRow(SCOPE, {
					...revision(t),
					rowId: t.rows[0].id,
					values: values([[columnId(t, "name"), "Changed"]]),
				}),
		},
		{
			label: "deleteLookupRow",
			run: (t) =>
				deleteLookupRow(SCOPE, { ...revision(t), rowId: t.rows[0].id }),
		},
		{
			label: "moveLookupRow",
			run: (t) =>
				moveLookupRow(SCOPE, {
					...revision(t),
					rowId: t.rows[0].id,
					toIndex: 1,
				}),
		},
		{
			label: "replaceLookupRows",
			run: (t) =>
				replaceLookupRows(SCOPE, {
					...revision(t),
					rows: [values([[columnId(t, "name"), "Only"]])],
				}),
		},
		{
			label: "governance remove-column",
			governance: true,
			run: (t) =>
				applyLookupSchemaGovernance(SCOPE, {
					kind: "remove-column",
					...revision(t),
					columnId: columnId(t, "count"),
				}),
		},
		{
			label: "governance retype-column",
			governance: true,
			run: (t) =>
				applyLookupSchemaGovernance(SCOPE, {
					kind: "retype-column",
					...revision(t),
					columnId: columnId(t, "count"),
					dataType: "int",
				}),
		},
		{ label: "batch name", run: inBatch({ name: "Renamed" }) },
		{
			label: "batch tag",
			run: (t) => inBatch({ tag: `${t.tag}_renamed` })(t),
		},
		{
			label: "batch add column",
			run: inBatch({
				columnOperations: [
					{
						kind: "add",
						key: "extra",
						column: { wireName: "extra", label: "Extra", dataType: "text" },
					},
				],
			}),
		},
		{
			label: "batch update column",
			run: (t) =>
				inBatch({
					columnOperations: [
						{ kind: "update", columnId: columnId(t, "name"), label: "Label" },
					],
				})(t),
		},
		{
			label: "batch move column",
			run: (t) =>
				inBatch({
					columnOperations: [
						{
							kind: "move",
							columnId: columnId(t, "name"),
							afterColumnId: columnId(t, "code"),
						},
					],
				})(t),
		},
		{
			label: "batch remove column",
			run: (t) =>
				inBatch({
					columnOperations: [
						{ kind: "remove", columnId: columnId(t, "count") },
					],
				})(t),
		},
		{
			label: "batch retype column",
			run: (t) =>
				inBatch({
					columnOperations: [
						{ kind: "retype", columnId: columnId(t, "count"), dataType: "int" },
					],
				})(t),
		},
		{
			label: "batch add row",
			run: (t) =>
				inBatch({
					rowOperations: [
						{
							kind: "add",
							key: "gamma",
							cells: [{ columnId: columnId(t, "name"), value: "Gamma" }],
						},
					],
				})(t),
		},
		{
			label: "batch update row",
			run: (t) =>
				inBatch({
					rowOperations: [
						{
							kind: "update",
							rowId: t.rows[0].id,
							cells: [{ columnId: columnId(t, "name"), value: "Changed" }],
						},
					],
				})(t),
		},
		{
			label: "batch move row",
			run: (t) =>
				inBatch({
					rowOperations: [
						{ kind: "move", rowId: t.rows[0].id, afterRowId: t.rows[1].id },
					],
				})(t),
		},
		{
			label: "batch remove row",
			run: (t) =>
				inBatch({ rowOperations: [{ kind: "remove", rowId: t.rows[0].id }] })(
					t,
				),
		},
		{
			label: "batch replace rows",
			run: (t) =>
				inBatch({
					replaceRows: [
						{
							key: "only",
							cells: [{ columnId: columnId(t, "name"), value: "Only" }],
						},
					],
				})(t),
		},
	];
}

async function projectRevision(): Promise<string> {
	return (await getLookupManifest(SCOPE)).projectRevision;
}

async function listen(
	body: (
		notifications: { projectId: string; revision: string }[],
	) => Promise<void>,
): Promise<void> {
	const listener = new Client({ connectionString: h.uri() });
	const notifications: { projectId: string; revision: string }[] = [];
	listener.on("notification", (notification: Notification) => {
		if (
			notification.channel === LOOKUP_STREAM_CHANNEL &&
			notification.payload
		) {
			notifications.push(JSON.parse(notification.payload));
		}
	});
	try {
		await listener.connect();
		await listener.query(`LISTEN ${LOOKUP_STREAM_CHANNEL}`);
		await body(notifications);
		await listener.query("SELECT 1");
	} finally {
		await listener.end();
	}
}

describe("the refusal every writer meets", () => {
	it("refuses each writer path of an author on a managed table and changes nothing", async () => {
		const table = await createManaged();
		const before = await projectRevision();
		for (const write of authorWrites()) {
			const error = await caught(write.run(table));
			if (write.governance) {
				expect(error, write.label).toBeInstanceOf(LookupSchemaGovernanceError);
			} else {
				expect(error, write.label).toBeInstanceOf(LookupError);
			}
			expect(error, write.label).toMatchObject({
				code: "managed_in_hq",
				message: `The lookup table districts is managed in CommCare HQ (${DOMAIN}), so Nova can't change it here. You can change it in CommCare HQ and refresh Nova's copy, or choose Manage in Nova on the table's page.`,
			});
			expect(await getLookupTable(SCOPE, table.id), write.label).toEqual(table);
			expect(await projectRevision(), write.label).toBe(before);
		}
	});

	it("lets every writer path through once the takeover pair is set", async () => {
		for (const [index, write] of authorWrites().entries()) {
			const table = await createManaged(`districts_${index}`);
			await takeOver(table.id);
			const current = await getLookupTable(SCOPE, table.id);
			await expect(write.run(current), write.label).resolves.toBeDefined();
		}
	});

	it("answers a stale revision on a managed table as managed, not as a conflict", async () => {
		const table = await createManaged();
		const error = await caught(
			updateLookupTableName(SCOPE, {
				tableId: table.id,
				expectedTableRevision: lookupTableRevision("0"),
				name: "Renamed",
			}),
		);
		expect(error).toMatchObject({ code: "managed_in_hq" });
	});

	it("deletes an unreferenced managed table and refuses a referenced one as referenced", async () => {
		const free = await createManaged("free_table");
		await applyLookupSchemaGovernance(SCOPE, {
			kind: "delete-table",
			tableId: free.id,
			expectedTableRevision: free.tableRevision,
		});
		const freeInBatch = await createManaged("free_in_batch");
		await inBatch({ delete: true })(freeInBatch);
		const listed = (await getLookupManifest(SCOPE)).tables.map((t) => t.id);
		expect(listed).not.toContain(free.id);
		expect(listed).not.toContain(freeInBatch.id);

		const read = await createManaged("read_table");
		const appId = await h.seedApp({
			id: "app-reads",
			project_id: SCOPE.projectId,
		});
		await h
			.db()
			.insertInto("lookup_table_references")
			.values({ project_id: SCOPE.projectId, table_id: read.id, app_id: appId })
			.execute();
		expect(
			await caught(
				applyLookupSchemaGovernance(SCOPE, {
					kind: "delete-table",
					tableId: read.id,
					expectedTableRevision: read.tableRevision,
				}),
			),
		).toMatchObject({ code: "referenced" });
		expect(await caught(inBatch({ delete: true })(read))).toMatchObject({
			code: "referenced",
		});
		expect(await getLookupTable(SCOPE, read.id)).toEqual(read);
	});
});

function lookupTableRevision(value: string) {
	return value as LookupTableSnapshot["tableRevision"];
}

describe("the create arm", () => {
	it("creates each table under the ids it is given, every column text, with its origin", async () => {
		const longField = "f".repeat(200);
		const content: ManagedLookupContent = {
			fields: ["name", longField],
			rows: [{ name: "Alpha", [longField]: "long" }, { name: "Beta" }],
		};
		const binding = bindingFor("long_fields", content.fields);
		const origin = originFor(content);
		await h
			.db()
			.transaction()
			.execute((tx) =>
				createManagedLookupTablesInTransaction(
					tx,
					SCOPE,
					[{ binding, name: "long_fields", content, origin }],
					AT,
				),
			);
		const table = await getLookupTable(SCOPE, binding.tableId);
		expect(table.columns).toEqual([
			{
				id: binding.columns.name,
				wireName: "name",
				label: "name",
				dataType: "text",
			},
			{
				id: binding.columns[longField],
				wireName: longField,
				label: "f".repeat(120),
				dataType: "text",
			},
		]);
		expect(table.rows.map((row) => row.values)).toEqual([
			values([
				[binding.columns.name, "Alpha"],
				[binding.columns[longField], "long"],
			]),
			values([[binding.columns.name, "Beta"]]),
		]);
		expect(table.hq).toEqual({
			server: "production",
			domain: DOMAIN,
			remoteId: "hq-table-1",
			managedBy: "commcare-hq",
			broughtInAt: AT.toISOString(),
			refreshedAt: AT.toISOString(),
			takenOverAt: null,
			takenOverBy: null,
			goneColumnIds: [],
		});
		const stored = await h
			.db()
			.selectFrom("lookup_tables")
			.select(["hq_canonical", "hq_brought_in_by", "hq_refreshed_by"])
			.where("id", "=", binding.tableId)
			.executeTakeFirstOrThrow();
		expect(stored).toEqual({
			hq_canonical: origin.canonical,
			hq_brought_in_by: SCOPE.actorId,
			hq_refreshed_by: SCOPE.actorId,
		});
		const entry = (await getLookupManifest(SCOPE)).tables[0];
		expect(entry.hq).toEqual(table.hq);
	});

	it("refuses a taken tag and keeps nothing of the call", async () => {
		await createLookupTable(SCOPE, {
			name: "Clinics",
			tag: "clinics",
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		});
		const before = await getLookupManifest(SCOPE);
		const first = bindingFor("wards", CONTENT.fields);
		const error = await caught(
			h
				.db()
				.transaction()
				.execute((tx) =>
					createManagedLookupTablesInTransaction(
						tx,
						SCOPE,
						[
							{
								binding: first,
								name: "wards",
								content: CONTENT,
								origin: originFor(CONTENT),
							},
							{
								binding: bindingFor("clinics", CONTENT.fields),
								name: "clinics",
								content: CONTENT,
								origin: originFor(CONTENT),
							},
						],
						AT,
					),
				),
		);
		expect(error).toMatchObject({ code: "tag_taken" });
		expect(await getLookupManifest(SCOPE)).toEqual(before);
	});

	it("rolls back the tables and rows it wrote before a later table fails", async () => {
		const plain = await createLookupTable(SCOPE, {
			name: "Clinics",
			tag: "clinics",
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		});
		const before = await getLookupManifest(SCOPE);
		const first = bindingFor("wards", CONTENT.fields);
		// The second table's id is the plain table's, which only its insert meets.
		const second = {
			...bindingFor("regions", CONTENT.fields),
			tableId: plain.id,
		};
		await caught(
			h
				.db()
				.transaction()
				.execute((tx) =>
					createManagedLookupTablesInTransaction(
						tx,
						SCOPE,
						[
							{
								binding: first,
								name: "wards",
								content: CONTENT,
								origin: originFor(CONTENT),
							},
							{
								binding: second,
								name: "regions",
								content: CONTENT,
								origin: originFor(CONTENT),
							},
						],
						AT,
					),
				),
		);
		expect(await getLookupManifest(SCOPE)).toEqual(before);
		const rows = await h
			.db()
			.selectFrom("lookup_rows")
			.select("id")
			.where("table_id", "=", first.tableId)
			.execute();
		expect(rows).toEqual([]);
	});

	it("advances the Project once and notifies once for three tables", async () => {
		const before = await projectRevision();
		await listen(async (notifications) => {
			const receipt = await h
				.db()
				.transaction()
				.execute((tx) =>
					createManagedLookupTablesInTransaction(
						tx,
						SCOPE,
						["wards", "regions", "zones"].map((tag) => ({
							binding: bindingFor(tag, CONTENT.fields),
							name: tag,
							content: CONTENT,
							origin: originFor(CONTENT),
						})),
						AT,
					),
				);
			expect(receipt.projectRevision).toBe(String(BigInt(before) + BigInt(1)));
			expect(receipt.tables).toHaveLength(3);
			await vi.waitFor(() => expect(notifications).toHaveLength(1));
			expect(notifications).toEqual([
				{ projectId: SCOPE.projectId, revision: receipt.projectRevision },
			]);
		});
	});
});

async function refresh(
	tableId: LookupTableId,
	content: ManagedLookupContent,
	mode: "refresh" | "adopt" = "refresh",
	newColumnIds?: Readonly<Record<string, LookupColumnId>>,
	remoteId?: string,
) {
	return h
		.db()
		.transaction()
		.execute((tx) =>
			refreshManagedLookupTableInTransaction(tx, SCOPE, {
				tableId,
				content,
				origin: originFor(content, remoteId),
				at: LATER,
				mode,
				...(newColumnIds === undefined ? {} : { newColumnIds }),
			}),
		);
}

describe("the refresh arm", () => {
	it("stamps the refresh and advances nothing when CommCare HQ's table is as it was", async () => {
		const table = await createManaged();
		const before = await projectRevision();
		const receipt = await refresh(table.id, CONTENT);
		expect(receipt).toMatchObject({
			changed: "nothing",
			tableRevision: table.tableRevision,
		});
		const after = await getLookupTable(SCOPE, table.id);
		expect(after.hq?.refreshedAt).toBe(LATER.toISOString());
		expect({ ...after, hq: undefined }).toEqual({ ...table, hq: undefined });
		expect(await projectRevision()).toBe(before);
	});

	it("advances the rows revision alone where only rows changed", async () => {
		const table = await createManaged();
		const changed: ManagedLookupContent = {
			fields: CONTENT.fields,
			rows: [{ name: "Alpha", code: "009" }, { name: "Delta" }],
		};
		const receipt = await refresh(table.id, changed);
		expect(receipt.changed).toBe("rows");
		expect(receipt.definitionRevision).toBe(table.definitionRevision);
		expect(receipt.rowsRevision).toBe(await projectRevision());
		const after = await getLookupTable(SCOPE, table.id);
		expect(after.rows.map((row) => row.values)).toEqual([
			values([
				[columnId(table, "name"), "Alpha"],
				[columnId(table, "code"), "009"],
			]),
			values([[columnId(table, "name"), "Delta"]]),
		]);
	});

	it("adds a column for a new field under the id it is given", async () => {
		const table = await createManaged();
		const given = lookupColumnIdSchema.parse(v7());
		const content: ManagedLookupContent = {
			fields: [...CONTENT.fields, "region"],
			rows: CONTENT.rows,
		};
		const receipt = await refresh(table.id, content, "refresh", {
			region: given,
		});
		expect(receipt.changed).toBe("definition");
		expect(receipt.addedColumns).toEqual([{ id: given, wireName: "region" }]);
		const after = await getLookupTable(SCOPE, table.id);
		expect(after.columns.map((column) => [column.id, column.dataType])).toEqual(
			[...table.columns.map((column) => [column.id, "text"]), [given, "text"]],
		);
	});

	it("removes the column of a field CommCare HQ dropped when nothing reads it", async () => {
		const table = await createManaged();
		const content: ManagedLookupContent = {
			fields: ["name", "code"],
			rows: CONTENT.rows,
		};
		const receipt = await refresh(table.id, content);
		expect(receipt).toMatchObject({
			changed: "definition",
			removedColumns: ["count"],
			keptGoneColumns: [],
		});
		const after = await getLookupTable(SCOPE, table.id);
		expect(after.columns.map((column) => column.wireName)).toEqual([
			"name",
			"code",
		]);
		expect(after.hq?.goneColumnIds).toEqual([]);
	});

	it("keeps, empty and last, a dropped column an app still reads, and names the app", async () => {
		const table = await createManaged();
		const appId = await h.seedApp({
			id: "app-reads",
			project_id: SCOPE.projectId,
		});
		await h
			.db()
			.insertInto("lookup_table_references")
			.values({
				project_id: SCOPE.projectId,
				table_id: table.id,
				app_id: appId,
			})
			.execute();
		await h
			.db()
			.insertInto("lookup_column_references")
			.values({
				project_id: SCOPE.projectId,
				table_id: table.id,
				column_id: columnId(table, "code"),
				app_id: appId,
			})
			.execute();
		const content: ManagedLookupContent = {
			fields: ["count", "name"],
			rows: [{ name: "Alpha", count: "3" }],
		};
		const receipt = await refresh(table.id, content);
		expect(receipt.keptGoneColumns).toEqual([
			{
				id: columnId(table, "code"),
				wireName: "code",
				apps: [{ appId, appName: expect.any(String), deleted: false }],
			},
		]);
		const after = await getLookupTable(SCOPE, table.id);
		expect(after.columns.map((column) => column.wireName)).toEqual([
			"count",
			"name",
			"code",
		]);
		expect(after.rows.map((row) => row.values)).toEqual([
			values([
				[columnId(table, "count"), "3"],
				[columnId(table, "name"), "Alpha"],
			]),
		]);
		expect(after.hq?.goneColumnIds).toEqual([columnId(table, "code")]);
	});

	it("makes a plain table CommCare HQ's copy in adopt mode", async () => {
		const plain = await createLookupTable(SCOPE, {
			name: "Districts",
			tag: "districts",
			columns: FIELDS.map((wireName) => ({
				wireName,
				label: wireName,
				dataType: "text" as const,
			})),
		});
		const receipt = await refresh(plain.id, CONTENT, "adopt");
		expect(receipt.changed).toBe("definition");
		const after = await getLookupTable(SCOPE, plain.id);
		expect(after.hq).toMatchObject({
			managedBy: "commcare-hq",
			domain: DOMAIN,
			broughtInAt: LATER.toISOString(),
			refreshedAt: LATER.toISOString(),
		});
	});

	it("clears a takeover in adopt mode and keeps when the table came in", async () => {
		const table = await createManaged();
		await takeOver(table.id);
		const before = await getLookupTable(SCOPE, table.id);
		expect(before.hq?.managedBy).toBe("nova");
		const receipt = await refresh(table.id, CONTENT, "adopt");
		expect(receipt.changed).toBe("definition");
		expect(receipt.definitionRevision).toBe(await projectRevision());
		const after = await getLookupTable(SCOPE, table.id);
		expect(after.hq).toMatchObject({
			managedBy: "commcare-hq",
			takenOverAt: null,
			takenOverBy: null,
			broughtInAt: AT.toISOString(),
		});
		expect(after.rows.map((row) => row.values)).toEqual(
			before.rows.map((row) => row.values),
		);
	});

	it("sets typed columns to text in adopt mode and holds CommCare HQ's strings as they stand", async () => {
		const plain = await createLookupTable(SCOPE, {
			name: "Facilities",
			tag: "facilities",
			columns: [
				{ wireName: "name", label: "Name", dataType: "text" },
				{ wireName: "rank", label: "Rank", dataType: "int" },
				{ wireName: "price", label: "Price", dataType: "decimal" },
				{ wireName: "opened", label: "Opened", dataType: "date" },
			],
		});
		const rank = columnId(plain, "rank");
		await createLookupRow(SCOPE, {
			tableId: plain.id,
			expectedTableRevision: plain.tableRevision,
			toIndex: 0,
			values: values([
				[columnId(plain, "name"), "Alpha"],
				[rank, 7],
				[columnId(plain, "price"), 1.5],
				[columnId(plain, "opened"), "2026-01-02"],
			]),
		});
		const appId = await h.seedApp({
			id: "app-reads",
			project_id: SCOPE.projectId,
		});
		await h
			.db()
			.insertInto("lookup_table_references")
			.values({
				project_id: SCOPE.projectId,
				table_id: plain.id,
				app_id: appId,
			})
			.execute();
		await h
			.db()
			.insertInto("lookup_column_references")
			.values({
				project_id: SCOPE.projectId,
				table_id: plain.id,
				column_id: rank,
				app_id: appId,
			})
			.execute();
		const content: ManagedLookupContent = {
			fields: ["name", "rank", "price", "opened"],
			rows: [
				{ name: "Alpha", rank: "007", price: "1.50", opened: "2026-01-02" },
			],
		};
		await refresh(plain.id, content, "adopt");
		const after = await getLookupTable(SCOPE, plain.id);
		expect(after.columns.map((column) => [column.id, column.dataType])).toEqual(
			plain.columns.map((column) => [column.id, "text"]),
		);
		expect(after.rows.map((row) => row.values)).toEqual([
			values([
				[columnId(plain, "name"), "Alpha"],
				[rank, "007"],
				[columnId(plain, "price"), "1.50"],
				[columnId(plain, "opened"), "2026-01-02"],
			]),
		]);
		const edges = await h
			.db()
			.selectFrom("lookup_column_references")
			.select("column_id")
			.where("table_id", "=", plain.id)
			.execute();
		expect(edges).toEqual([{ column_id: rank }]);
		const fixtureData = await getLookupFixtureData(SCOPE, [plain.id]);
		const fixtures = buildLookupFixtures(
			lookupWireNaming(fixtureData.definitions),
			fixtureData.rowsByTable,
		);
		expect(fixtures.fixtures[0].xml).toContain("<rank>007</rank>");
	});

	it("stamps the definition in adopt mode when columns and rows are already equal", async () => {
		const table = await createManaged();
		await takeOver(table.id);
		const receipt = await refresh(table.id, CONTENT, "adopt");
		expect(receipt.rowsRevision).toBe(table.rowsRevision);
		expect(receipt.definitionRevision).not.toBe(table.definitionRevision);
		expect(receipt.definitionRevision).toBe(await projectRevision());
	});

	it("refuses a refresh of a table taken over meanwhile as a conflict", async () => {
		const table = await createManaged();
		await takeOver(table.id);
		const before = await getLookupTable(SCOPE, table.id);
		expect(await caught(refresh(table.id, CONTENT))).toMatchObject({
			code: "conflict",
		});
		expect(await getLookupTable(SCOPE, table.id)).toEqual(before);
	});

	it("holds an author's row update at the lock and refuses it once the hand-back commits", async () => {
		const table = await createManaged();
		await takeOver(table.id);
		const loaded = await getLookupTable(SCOPE, table.id);
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let adopted: () => void = () => {};
		const adoptedSignal = new Promise<void>((resolve) => {
			adopted = resolve;
		});
		const handBack = h
			.db()
			.transaction()
			.execute(async (tx) => {
				const receipt = await refreshManagedLookupTableInTransaction(
					tx,
					SCOPE,
					{
						tableId: table.id,
						content: CONTENT,
						origin: originFor(CONTENT),
						at: LATER,
						mode: "adopt",
					},
				);
				adopted();
				await released;
				return receipt;
			});
		let update: Promise<unknown> | undefined;
		try {
			await adoptedSignal;
			update = updateLookupRow(SCOPE, {
				tableId: table.id,
				expectedTableRevision: loaded.tableRevision,
				rowId: loaded.rows[0].id,
				values: values([[columnId(loaded, "name"), "Edited in a second tab"]]),
			});
			const blocked = update.catch(() => undefined);
			await vi.waitFor(async () => {
				const waiting = await sql<{ count: number }>`
					SELECT count(*)::integer AS count FROM pg_stat_activity
					WHERE datname = current_database() AND wait_event_type = 'Lock'
				`.execute(h.db());
				expect(waiting.rows[0]?.count).toBeGreaterThan(0);
			});
			release();
			await handBack;
			await blocked;
			expect(await caught(update)).toMatchObject({ code: "managed_in_hq" });
		} finally {
			release();
			await handBack.catch(() => undefined);
			await update?.catch(() => undefined);
		}
		const after = await getLookupTable(SCOPE, table.id);
		expect(after.rows.map((row) => row.values)).toEqual(
			loaded.rows.map((row) => row.values),
		);
	});
});

describe("the two CHECKs", () => {
	it("refuses an origin stored in part and a takeover with no origin", async () => {
		const plain = await createLookupTable(SCOPE, {
			name: "Clinics",
			tag: "clinics",
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		});
		expect(
			await caught(
				h
					.db()
					.updateTable("lookup_tables")
					.set({ hq_server: "production", hq_domain: DOMAIN })
					.where("id", "=", plain.id)
					.execute(),
			),
		).toMatchObject({ constraint: "lookup_tables_hq_origin_whole" });
		expect(
			await caught(
				h
					.db()
					.updateTable("lookup_tables")
					.set({ hq_taken_over_at: LATER, hq_taken_over_by: SCOPE.actorId })
					.where("id", "=", plain.id)
					.execute(),
			),
		).toMatchObject({ constraint: "lookup_tables_hq_takeover_attributed" });
	});
});
