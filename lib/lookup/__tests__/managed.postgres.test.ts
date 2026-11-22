// Live-Postgres coverage for lookup tables CommCare HQ manages: the refusal
// every writer meets, the create arm and the refresh arm.

import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { Client, type Notification } from "pg";
import { v7 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	readLookupReferencingApps,
	replaceLookupReferenceEdges,
} from "@/lib/db/lookupReferenceEdges";
import { type AppDatabase, LOOKUP_STREAM_CHANNEL } from "@/lib/db/pg";
import {
	type LookupColumnId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { HAND_BACK_OVERTAKEN } from "@/lib/publish/managedData";
import { applyLookupAuthoringBatchInTransaction } from "../authoringBatch";
import { LookupError } from "../errors";
import {
	createManagedLookupTablesInTransaction,
	LookupReviewMovedError,
	type ManagedLookupContent,
	type ManagedOriginWrite,
	type ManagedTableReviewed,
	refreshManagedLookupTableInTransaction,
	takeOverManagedLookupTableInTransaction,
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
	getLookupTableWindow,
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
import {
	authorizeLookupWriteInTransaction,
	LookupAuthorityError,
} from "../writerTransaction";

/* Three connections: a held hand-back, an author's write waiting at its lock,
 * and the observer that sees it wait. */
const h = setupAppStateTestDb("lookup_managed_", { poolMax: 3 });

const SCOPE: LookupScope = {
	projectId: "project-managed",
	actorId: "managed-writer",
	role: "owner",
};
const DOMAIN = "district-health";

/* Every lookup writer reads its member's role on its own transaction. */
beforeEach(async () => {
	await h.seedProjectMember(SCOPE.actorId, SCOPE.projectId, "owner");
});

/** The authority a production caller reads on the write's own transaction. */
function authorized(
	tx: Transaction<AppDatabase>,
	capability: "edit" | "delete" = "delete",
	writer: { readonly projectId: string; readonly actorId: string } = SCOPE,
) {
	return authorizeLookupWriteInTransaction(tx, writer, capability);
}

/**
 * The table as a person or a reading reviews it before an adoption: its
 * revisions and the apps whose edges name it, read now.
 */
async function reviewedNow(
	tableId: LookupTableId,
): Promise<ManagedTableReviewed> {
	const table = await getLookupTable(SCOPE, tableId);
	const readers = await readLookupReferencingApps(h.db(), {
		projectId: SCOPE.projectId,
		tableId,
	});
	return {
		definitionRevision: table.definitionRevision,
		rowsRevision: table.rowsRevision,
		readerAppIds: readers.map((app) => app.appId).sort(),
	};
}
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
		.execute(async (tx) =>
			createManagedLookupTablesInTransaction(
				tx,
				await authorized(tx),
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
			.execute(async (tx) =>
				applyLookupAuthoringBatchInTransaction(tx, await authorized(tx), {
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
			.execute(async (tx) =>
				createManagedLookupTablesInTransaction(
					tx,
					await authorized(tx),
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
				index: "unobserved",
			},
			{
				id: binding.columns[longField],
				wireName: longField,
				label: "f".repeat(120),
				dataType: "text",
				index: "unobserved",
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
		/* The manifest carries who manages the table, never the day of the
		 * last refresh nor the gone columns. */
		const entry = (await getLookupManifest(SCOPE)).tables[0];
		expect(entry.hq).toEqual({
			server: "production",
			domain: DOMAIN,
			remoteId: "hq-table-1",
			managedBy: "commcare-hq",
			broughtInAt: AT.toISOString(),
			takenOverAt: null,
			takenOverBy: null,
		});
	});

	it("binds a wide reference without representing its unreadable inventory as zero rows", async () => {
		const fields = Array.from({ length: 251 }, (_, i) => `column_${i}`);
		const content = { fields, rows: [] };
		const origin = originFor(content);
		const binding = bindingFor("wide_roster", fields);
		const canonical = {
			...origin.canonical,
			rowCount: null,
			source: {
				inventory: "unavailable",
				distribution: "assigned",
				indexEvidence: "unobserved",
			},
		};
		await h
			.db()
			.transaction()
			.execute(async (tx) =>
				createManagedLookupTablesInTransaction(
					tx,
					await authorized(tx),
					[
						{
							binding,
							name: "Roster",
							origin: { ...origin, canonical },
							content,
						},
					],
					AT,
				),
			);
		const snapshot = await getLookupTableWindow(SCOPE, binding.tableId);
		expect(snapshot.rowsUnavailable).toBe(true);
		expect(snapshot.columns.map((col) => col.id)).toEqual(
			fields.map((name) => binding.columns[name]),
		);
		await expect(getLookupTable(SCOPE, binding.tableId)).rejects.toMatchObject({
			code: "managed_in_hq",
		});
	});

	it("refuses a cell over the cap with the cap's phrase, its size above the cap's", async () => {
		const content: ManagedLookupContent = {
			fields: ["name"],
			rows: [{ name: "x".repeat(64 * 1024 + 1) }],
		};
		const before = await getLookupManifest(SCOPE);
		const error = await caught(
			h
				.db()
				.transaction()
				.execute(async (tx) =>
					createManagedLookupTablesInTransaction(
						tx,
						await authorized(tx),
						[
							{
								binding: bindingFor("wide_cells", content.fields),
								name: "wide_cells",
								content,
								origin: originFor(content),
							},
						],
						AT,
					),
				),
		);
		expect(error).toBeInstanceOf(LookupError);
		expect(error).toMatchObject({
			code: "storage_limit",
			message:
				"The lookup table wide_cells has a value of 64.1 KB (Nova takes 64 KB in one cell) in CommCare HQ, so Nova can't hold a copy of it.",
		});
		expect(await getLookupManifest(SCOPE)).toEqual(before);
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
				.execute(async (tx) =>
					createManagedLookupTablesInTransaction(
						tx,
						await authorized(tx),
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
				.execute(async (tx) =>
					createManagedLookupTablesInTransaction(
						tx,
						await authorized(tx),
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
				.execute(async (tx) =>
					createManagedLookupTablesInTransaction(
						tx,
						await authorized(tx),
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
	const base = {
		tableId,
		content,
		origin: originFor(content, remoteId),
		at: LATER,
		olderReadYields: true,
		...(newColumnIds === undefined ? {} : { newColumnIds }),
	};
	const input =
		mode === "adopt"
			? { ...base, mode, reviewed: await reviewedNow(tableId) }
			: { ...base, mode };
	return h
		.db()
		.transaction()
		.execute(async (tx) =>
			refreshManagedLookupTableInTransaction(tx, await authorized(tx), input),
		);
}

describe("the refresh arm", () => {
	it("binds row attributes and repeated properties by owner and refreshes rows by source identity", async () => {
		const content = {
			fields: ["label"],
			attributes: ["lang"],
			fieldDetails: {
				label: { repeated: true, index: "unobserved", properties: ["lang"] },
			},
			rows: [{}, {}],
			rowDetails: [
				{
					remoteId: "one",
					sortKey: 0,
					attributes: { lang: "x" },
					occurrences: { label: [{ text: " 007", properties: { lang: "y" } }] },
				},
				{
					remoteId: "two",
					sortKey: 7,
					attributes: { lang: "z" },
					occurrences: { label: [] },
				},
			],
		} satisfies ManagedLookupContent;
		const table = await createManaged("catalog", content);
		const col = table.columns[0];
		const prop = col.properties?.[0]?.id;
		const attr = table.attributes?.[0]?.id;
		if (!prop || !attr) throw new Error("The source details were not stored.");
		expect(prop).not.toBe(attr);
		expect(table.rows[0].attributes).toEqual({ [attr]: "x" });
		expect(table.rows[0].occurrences).toEqual({
			[col.id]: [{ text: " 007", properties: { [prop]: "y" } }],
		});
		const change = await refresh(table.id, {
			...content,
			rowDetails: [
				{ ...content.rowDetails[1], sortKey: 0 },
				{ ...content.rowDetails[0], remoteId: "replacement", sortKey: 7 },
			],
		});
		expect(change.changed).toBe("rows");
		expect(change.definitionRevision).toBe(table.definitionRevision);
		const after = await getLookupTable(SCOPE, table.id);
		expect(after.rows[0].id).toBe(table.rows[1].id);
		expect(after.rows[1].id).not.toBe(table.rows[0].id);
		expect(after.attributes).toEqual(table.attributes);
		expect(after.columns).toEqual(table.columns);
		await expect(
			refresh(table.id, {
				...content,
				fields: [],
				fieldDetails: {},
				rowDetails: [
					{ remoteId: "one", attributes: {} },
					{ remoteId: "two", attributes: { lang: "" } },
				],
			}),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect((await getLookupTable(SCOPE, table.id)).rowsRevision).toBe(
			after.rowsRevision,
		);
	});
	it("stamps the refresh and advances nothing when CommCare HQ's table is as it was, leaving every byte of the manifest", async () => {
		const table = await createManaged();
		const manifest = JSON.stringify(await getLookupManifest(SCOPE));
		const receipt = await refresh(table.id, CONTENT);
		expect(receipt).toMatchObject({
			changed: "nothing",
			tableRevision: table.tableRevision,
		});
		const after = await getLookupTable(SCOPE, table.id);
		expect(after.hq?.refreshedAt).toBe(LATER.toISOString());
		expect({ ...after, hq: undefined }).toEqual({ ...table, hq: undefined });
		/* One revision's manifest never changes: every open page holds these
		 * bytes for it, and a frame that differs at the same revision is a
		 * corrupt one to them. */
		expect(JSON.stringify(await getLookupManifest(SCOPE))).toBe(manifest);
	});

	it("stores CommCare HQ's moved digest and leaves every byte of the manifest where the copy is as it was", async () => {
		const table = await createManaged();
		const manifest = JSON.stringify(await getLookupManifest(SCOPE));
		const origin = {
			...originFor(CONTENT),
			canonical: { ...originFor(CONTENT).canonical, digest: "b".repeat(64) },
		};
		const receipt = await h
			.db()
			.transaction()
			.execute(async (tx) =>
				refreshManagedLookupTableInTransaction(tx, await authorized(tx), {
					tableId: table.id,
					content: CONTENT,
					origin,
					at: LATER,
					mode: "refresh",
					olderReadYields: true,
				}),
			);
		expect(receipt).toMatchObject({
			changed: "nothing",
			tableRevision: table.tableRevision,
		});
		const stored = await h
			.db()
			.selectFrom("lookup_tables")
			.select("hq_canonical")
			.where("id", "=", table.id)
			.executeTakeFirstOrThrow();
		expect(stored.hq_canonical).toMatchObject({ digest: "b".repeat(64) });
		expect(JSON.stringify(await getLookupManifest(SCOPE))).toBe(manifest);
	});

	it("changes the definition, and tells every open page, when only which columns read as gone moves", async () => {
		const empty: ManagedLookupContent = { fields: FIELDS, rows: [] };
		const table = await createManaged("districts", empty);
		const appId = await h.seedApp({
			id: "app-reads-count",
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
				column_id: columnId(table, "count"),
				app_id: appId,
			})
			.execute();
		const entryOf = async () =>
			(await getLookupManifest(SCOPE)).tables.find(
				(entry) => entry.id === table.id,
			);

		/* CommCare HQ drops the last field: the column an app reads stays where
		 * it stood and no row changes, so only the gone set moves. */
		const seen: { dropped?: Awaited<ReturnType<typeof refresh>> } = {};
		await listen(async (notifications) => {
			const receipt = await refresh(table.id, {
				fields: ["name", "code"],
				rows: [],
			});
			seen.dropped = receipt;
			expect(receipt).toMatchObject({
				changed: "definition",
				addedColumns: [],
				removedColumns: [],
				keptGoneColumns: [{ id: columnId(table, "count"), wireName: "count" }],
				rowsRevision: table.rowsRevision,
			});
			expect(receipt.definitionRevision).toBe(await projectRevision());
			expect(receipt.definitionRevision).not.toBe(table.definitionRevision);
			await vi.waitFor(() => expect(notifications).toHaveLength(1));
			expect(notifications).toEqual([
				{ projectId: SCOPE.projectId, revision: receipt.definitionRevision },
			]);
		});
		const { dropped } = seen;
		if (dropped === undefined) throw new Error("The refresh did not answer.");
		expect((await entryOf())?.tableRevision).toBe(dropped.tableRevision);
		expect((await getLookupTable(SCOPE, table.id)).hq?.goneColumnIds).toEqual([
			columnId(table, "count"),
		]);

		/* The field comes back in CommCare HQ: its column matches it by wire
		 * name, in place, and the badge it carried goes. */
		const back = await refresh(table.id, empty);
		expect(back).toMatchObject({ changed: "definition", keptGoneColumns: [] });
		expect(back.definitionRevision).toBe(await projectRevision());
		expect(BigInt(back.definitionRevision)).toBeGreaterThan(
			BigInt(dropped.definitionRevision),
		);
		expect((await entryOf())?.tableRevision).toBe(back.tableRevision);
		expect((await getLookupTable(SCOPE, table.id)).hq?.goneColumnIds).toEqual(
			[],
		);
	});

	it("mints a column for a new field named like an object's own members", async () => {
		const table = await createManaged();
		const content: ManagedLookupContent = {
			fields: [...CONTENT.fields, "constructor", "toString", "__proto__"],
			rows: [{ name: "Alpha", constructor: "c", toString: "t" }],
		};
		const receipt = await refresh(table.id, content);
		expect(receipt.changed).toBe("definition");
		expect(receipt.addedColumns.map((column) => column.wireName)).toEqual([
			"constructor",
			"toString",
			"__proto__",
		]);
		for (const column of receipt.addedColumns) {
			expect(lookupColumnIdSchema.safeParse(column.id).success).toBe(true);
		}
		const after = await getLookupTable(SCOPE, table.id);
		expect(after.columns.map((column) => column.wireName)).toEqual(
			content.fields,
		);
		const byWireName = new Map(
			receipt.addedColumns.map((column) => [column.wireName, column.id]),
		);
		expect(after.rows.map((row) => row.values)).toEqual([
			values([
				[columnId(table, "name"), "Alpha"],
				[byWireName.get("constructor") as LookupColumnId, "c"],
				[byWireName.get("toString") as LookupColumnId, "t"],
			]),
		]);
	});

	it("refuses a cell over the cap with the cap's phrase before any column is written", async () => {
		const table = await createManaged();
		const content: ManagedLookupContent = {
			fields: [...CONTENT.fields, "notes"],
			rows: [{ name: "Alpha", notes: "x".repeat(64 * 1024 + 1) }],
		};
		const error = await caught(refresh(table.id, content));
		expect(error).toBeInstanceOf(LookupError);
		expect(error).toMatchObject({
			code: "storage_limit",
			message:
				"The lookup table districts has a value of 64.1 KB (Nova takes 64 KB in one cell) in CommCare HQ, so Nova can't hold a copy of it.",
		});
		expect(await getLookupTable(SCOPE, table.id)).toEqual(table);
	});

	it("reports no gone column on a table Nova manages, whatever its columns became", async () => {
		const table = await createManaged();
		await takeOver(table.id);
		const added = await addLookupColumn(SCOPE, {
			tableId: table.id,
			expectedTableRevision: (await getLookupTable(SCOPE, table.id))
				.tableRevision,
			column: { wireName: "notes", label: "Notes", dataType: "text" },
		});
		await updateLookupColumnWireName(SCOPE, {
			tableId: table.id,
			expectedTableRevision: added.tableRevision,
			columnId: columnId(table, "code"),
			wireName: "district_code",
		});
		const after = await getLookupTable(SCOPE, table.id);
		expect(after.columns.map((column) => column.wireName)).toEqual([
			"name",
			"district_code",
			"count",
			"notes",
		]);
		expect(after.hq).toMatchObject({ managedBy: "nova", goneColumnIds: [] });
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
		const reviewed = await reviewedNow(table.id);
		const handBack = h
			.db()
			.transaction()
			.execute(async (tx) => {
				const receipt = await refreshManagedLookupTableInTransaction(
					tx,
					await authorized(tx),
					{
						tableId: table.id,
						content: CONTENT,
						origin: originFor(CONTENT),
						at: LATER,
						mode: "adopt",
						reviewed,
						olderReadYields: true,
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

describe("a refresh whose read of CommCare HQ began before the copy's last write", () => {
	/* No lock spans a read of CommCare HQ, so refresh A can read at T1, refresh
	 * B read at T2 and commit, and A commit after it. */
	const T1 = new Date("2026-11-01T12:00:00.000Z");
	const NEWER: ManagedLookupContent = {
		fields: FIELDS,
		rows: [{ name: "Gamma", code: "003" }],
	};
	const OLDER: ManagedLookupContent = {
		fields: FIELDS,
		rows: [{ name: "Alpha", code: "001" }],
	};

	async function refreshAt(
		tableId: LookupTableId,
		content: ManagedLookupContent,
		at: Date,
		mode: "refresh" | "adopt" = "refresh",
	) {
		const base = {
			tableId,
			content,
			origin: originFor(content),
			at,
			olderReadYields: true,
		};
		const input =
			mode === "adopt"
				? { ...base, mode, reviewed: await reviewedNow(tableId) }
				: { ...base, mode };
		return h
			.db()
			.transaction()
			.execute(async (tx) =>
				refreshManagedLookupTableInTransaction(tx, await authorized(tx), input),
			);
	}

	it("writes nothing over the newer read and keeps its date", async () => {
		const table = await createManaged();
		expect((await refreshAt(table.id, NEWER, LATER)).changed).toBe("rows");
		const after = await getLookupTable(SCOPE, table.id);
		const manifest = JSON.stringify(await getLookupManifest(SCOPE));

		const receipt = await refreshAt(table.id, OLDER, T1);
		expect(receipt).toMatchObject({
			changed: "superseded",
			tableRevision: after.tableRevision,
		});
		const now = await getLookupTable(SCOPE, table.id);
		expect(now.rows.map((row) => row.values)).toEqual(
			after.rows.map((row) => row.values),
		);
		expect(now.hq?.refreshedAt).toBe(LATER.toISOString());
		expect(JSON.stringify(await getLookupManifest(SCOPE))).toBe(manifest);
	});

	it("writes nothing over a hand-back recorded since", async () => {
		const table = await createManaged();
		await takeOver(table.id);
		// The hand-back, reading CommCare HQ after the takeover.
		const handedBackAt = new Date(LATER.getTime() + 60_000);
		expect(
			(await refreshAt(table.id, NEWER, handedBackAt, "adopt")).changed,
		).not.toBe("superseded");
		const after = await getLookupTable(SCOPE, table.id);
		// A second hand-back whose read began before the first one's.
		const receipt = await refreshAt(table.id, OLDER, LATER, "adopt");
		expect(receipt.changed).toBe("superseded");
		const now = await getLookupTable(SCOPE, table.id);
		expect(now.rows).toEqual(after.rows);
		expect(now.hq).toMatchObject({
			managedBy: "commcare-hq",
			refreshedAt: handedBackAt.toISOString(),
		});
	});

	it("refuses a hand-back whose read began before someone chose Manage in Nova", async () => {
		const table = await createManaged();
		await takeOver(table.id); // taken over at LATER
		const before = await getLookupTable(SCOPE, table.id);
		await expect(refreshAt(table.id, NEWER, T1, "adopt")).rejects.toMatchObject(
			{ code: "conflict", message: HAND_BACK_OVERTAKEN },
		);
		const now = await getLookupTable(SCOPE, table.id);
		expect(now.hq).toMatchObject({ managedBy: "nova" });
		expect(now.rows).toEqual(before.rows);
	});
});

describe("the lookup write contract", () => {
	const EDITOR = { projectId: SCOPE.projectId, actorId: "managed-editor" };

	it("reads the member's role on the write's own transaction: a scope built before the member left writes nothing", async () => {
		const table = await createLookupTable(SCOPE, {
			name: "Plain",
			tag: "plain_contract",
			columns: [{ wireName: "code", label: "Code", dataType: "text" }],
		});
		/* The scope still says owner, as one a request built before the removal does. */
		await sql`DELETE FROM auth_member WHERE "userId" = ${SCOPE.actorId}`.execute(
			h.db(),
		);
		const refused = await caught(
			createLookupRow(SCOPE, {
				tableId: table.id,
				expectedTableRevision: table.tableRevision,
				toIndex: 0,
				values: values([[table.columns[0].id, "001"]]),
			}),
		);
		expect(refused).toBeInstanceOf(LookupAuthorityError);
		expect(refused).toMatchObject({
			code: "not_found",
			standing: "not-a-member",
		});
		expect(
			await caught(
				applyLookupSchemaGovernance(SCOPE, {
					kind: "delete-table",
					tableId: table.id,
					expectedTableRevision: table.tableRevision,
				}),
			),
		).toMatchObject({ code: "not_found" });
		await h.seedProjectMember(SCOPE.actorId, SCOPE.projectId, "owner");
		expect(await getLookupTable(SCOPE, table.id)).toEqual(table);
	});

	it("refuses an adoption and a takeover by a member who can only edit, inside the writer", async () => {
		await h.seedProjectMember(EDITOR.actorId, EDITOR.projectId, "editor");
		const plain = await createLookupTable(SCOPE, {
			name: "Plain",
			tag: "plain_adopt",
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		});
		const reviewed = await reviewedNow(plain.id);
		const adopt = await caught(
			h
				.db()
				.transaction()
				.execute(async (tx) =>
					refreshManagedLookupTableInTransaction(
						tx,
						await authorized(tx, "edit", EDITOR),
						{
							tableId: plain.id,
							content: CONTENT,
							origin: originFor(CONTENT),
							at: LATER,
							mode: "adopt",
							reviewed,
							olderReadYields: true,
						},
					),
				),
		);
		expect(adopt).toMatchObject({
			standing: "below-capability",
			capability: "delete",
		});
		expect(await getLookupTable(SCOPE, plain.id)).toEqual(plain);

		const managed = await createManaged("managed_takeover");
		const takeover = await caught(
			h
				.db()
				.transaction()
				.execute(async (tx) =>
					takeOverManagedLookupTableInTransaction(
						tx,
						await authorized(tx, "edit", EDITOR),
						managed.id,
						await reviewedNow(managed.id),
						LATER,
					),
				),
		);
		expect(takeover).toMatchObject({ standing: "below-capability" });
		expect(await getLookupTable(SCOPE, managed.id)).toEqual(managed);
	});

	it("refuses an authority read on another transaction", async () => {
		const table = await createManaged("other_transaction");
		const stale = await h
			.db()
			.transaction()
			.execute((tx) => authorized(tx));
		await expect(
			h
				.db()
				.transaction()
				.execute((tx) =>
					refreshManagedLookupTableInTransaction(tx, stale, {
						tableId: table.id,
						content: CONTENT,
						origin: originFor(CONTENT),
						at: LATER,
						mode: "refresh",
						olderReadYields: true,
					}),
				),
		).rejects.toThrow(/authority read on another transaction/);
	});

	it("holds an adoption to the apps that read the table when it was reviewed", async () => {
		const plain = await createLookupTable(SCOPE, {
			name: "Plain",
			tag: "plain_readers",
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		});
		const reviewed = await reviewedNow(plain.id);
		expect(reviewed.readerAppIds).toEqual([]);
		/* An app starts reading the table: no revision of the table moves. */
		const appId = await h.seedApp({
			id: "app-new-reader",
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
		const adopt = (held: ManagedTableReviewed) =>
			h
				.db()
				.transaction()
				.execute(async (tx) =>
					refreshManagedLookupTableInTransaction(tx, await authorized(tx), {
						tableId: plain.id,
						content: CONTENT,
						origin: originFor(CONTENT),
						at: LATER,
						mode: "adopt",
						reviewed: held,
						olderReadYields: true,
					}),
				);
		const moved = await caught(adopt(reviewed));
		expect(moved).toBeInstanceOf(LookupReviewMovedError);
		expect(moved).toMatchObject({ code: "conflict" });
		expect(await getLookupTable(SCOPE, plain.id)).toEqual(plain);
		const now = await reviewedNow(plain.id);
		expect(now.readerAppIds).toEqual([appId]);
		expect((await adopt(now)).changed).toBe("definition");
	});

	it("keeps an app commit from adding a reader until the adoption holding the table's lock commits", async () => {
		const plain = await createLookupTable(SCOPE, {
			name: "Plain",
			tag: "plain_lock",
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		});
		const appId = await h.seedApp({
			id: "app-waits",
			project_id: SCOPE.projectId,
		});
		const reviewed = await reviewedNow(plain.id);
		const adopted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const adoption = h
			.db()
			.transaction()
			.execute(async (tx) => {
				await refreshManagedLookupTableInTransaction(tx, await authorized(tx), {
					tableId: plain.id,
					content: CONTENT,
					origin: originFor(CONTENT),
					at: LATER,
					mode: "adopt",
					reviewed,
					olderReadYields: true,
				});
				adopted.resolve();
				await release.promise;
			});
		let edges: Promise<void> | undefined;
		try {
			await adopted.promise;
			let landed = false;
			edges = h
				.db()
				.transaction()
				.execute((tx) =>
					replaceLookupReferenceEdges(tx, {
						appId,
						projectId: SCOPE.projectId,
						targets: { tableIds: [plain.id], columnTargets: [] },
					}),
				)
				.then(() => {
					landed = true;
				});
			await vi.waitFor(async () => {
				const waiting = await sql<{ count: number }>`
					SELECT count(*)::integer AS count FROM pg_stat_activity
					WHERE datname = current_database() AND wait_event_type = 'Lock'
				`.execute(h.db());
				expect(waiting.rows[0]?.count).toBeGreaterThan(0);
			});
			expect(landed).toBe(false);
			release.resolve();
			await adoption;
			await edges;
			expect(landed).toBe(true);
		} finally {
			release.resolve();
			await adoption.catch(() => undefined);
			await edges?.catch(() => undefined);
		}
		expect((await reviewedNow(plain.id)).readerAppIds).toEqual([appId]);
		expect((await getLookupTable(SCOPE, plain.id)).hq?.managedBy).toBe(
			"commcare-hq",
		);
	});

	it("holds a takeover to the table it was reviewed at", async () => {
		const managed = await createManaged("takeover_review");
		const reviewed = await reviewedNow(managed.id);
		await refresh(managed.id, {
			fields: CONTENT.fields,
			rows: [{ name: "Gamma", code: "003" }],
		});
		const moved = await caught(
			h
				.db()
				.transaction()
				.execute(async (tx) =>
					takeOverManagedLookupTableInTransaction(
						tx,
						await authorized(tx),
						managed.id,
						reviewed,
						LATER,
					),
				),
		);
		expect(moved).toBeInstanceOf(LookupReviewMovedError);
		expect((await getLookupTable(SCOPE, managed.id)).hq?.managedBy).toBe(
			"commcare-hq",
		);
	});
});
