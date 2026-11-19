/**
 * A lookup table CommCare HQ manages, through a publish and through the
 * services a person reaches it by (Refresh, Manage in Nova, the hand-back),
 * over real Postgres and a peer standing in for CommCare HQ.
 *
 * The lookup answers are written here in the shapes
 * `lib/commcare/hq/lookupTables.ts` reads (`managedFixtures.ts`); every app
 * source is CommCare HQ's own answer, retained by the proof lane.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { BlueprintDoc } from "@/lib/domain";
import { getLookupManifest, getLookupTable } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";
import { driftDate } from "@/lib/publish/driftReference";
import {
	CONNECT_TO_REFRESH_TABLE,
	cannotReadManagedTables,
	HAND_BACK_OFFERED,
	MANAGED_DATA_CHANGED,
	MANAGED_TABLE_HANDED_BACK_AFTER_CREATE,
	MANAGED_TABLE_NO_COLUMNS,
	managedColumnGoneItem,
	managedDataPassed,
	managedDataUnreadablePermission,
	managedTableFromElsewhereItem,
	managedTableGone,
	managedTableUnrepresentable,
	managedTableUnsupported,
} from "@/lib/publish/managedData";
import { PLAN_FEATURE_IDS } from "@/lib/publish/planFeatures";
import {
	LOOKUP_TABLE_NOT_FOUND,
	letHqManageLookupTable,
	manageLookupTableInNova,
	refreshManagedLookupTable,
} from "../managedData";
import { type PublishOutcome, publishAppToHq } from "../service";
import type { DeploymentConfirmationKey } from "../types";
import {
	acceptImport,
	connect,
	HOST,
	type ManagedCopy,
	makeManagedCopy,
	publishRequests,
	readerOf,
	refuseRows,
	rowsPath,
	type ServedTable,
	serveRows,
	serveSource,
	serveTableList,
	sourcePath,
	tablesPath,
	takeWorkbook,
	workbookPath,
} from "./managedFixtures";
import { reloadHeadFor } from "./publishFixtures";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});

const h = setupAppStateTestDb("managed_tables_", { authSchema: "migrated" });
const APP = "visits-app";
const PROJECT = "program";
const PUBLISHER = "publisher";
const ADMIN = "admin";
const DOMAIN = "clinic";
const TARGET = { server: "india", domain: DOMAIN } as const;
const EDITOR_LOOKUP: LookupScope = {
	projectId: PROJECT,
	actorId: PUBLISHER,
	role: "editor",
};
const ADMIN_LOOKUP: LookupScope = {
	projectId: PROJECT,
	actorId: ADMIN,
	role: "admin",
};
const TABLES = tablesPath(DOMAIN);
const SOURCE = sourcePath(DOMAIN);
const IMPORT = "/a/clinic/apps/api/import_app/";
const WORKBOOK = workbookPath(DOMAIN);

const facilities: ServedTable = {
	id: "hq-facilities",
	tag: "facilities",
	fields: ["code", "name"],
	rows: [
		{ code: "001", name: "North" },
		{ code: "002", name: "South" },
	],
};
const ROWS = rowsPath(DOMAIN, facilities);

const CONFIRM_ALL: readonly DeploymentConfirmationKey[] = [
	...PLAN_FEATURE_IDS.map((subject) => ({
		kind: "plan-feature" as const,
		subject,
	})),
	{ kind: "flat-location-fixture" },
	{ kind: "connect-forwarder" },
	{ kind: "form-entry-sync-off" },
];

/** The Project's two members, each connected to CommCare HQ on `india`. */
async function members(): Promise<void> {
	await h.seedProjectMember(PUBLISHER, PROJECT, "editor");
	await h.seedProjectMember(ADMIN, PROJECT, "admin");
	await connect(h, PUBLISHER, "india", [DOMAIN]);
	await connect(h, ADMIN, "india", [DOMAIN]);
}

/** The app, reading a copy CommCare HQ manages in the target, made from `served`. */
async function seedApp(
	served: ServedTable = facilities,
): Promise<{ doc: BlueprintDoc; copy: ManagedCopy }> {
	await members();
	const copy = await makeManagedCopy(h, EDITOR_LOOKUP, served, TARGET);
	const doc = readerOf([copy]);
	await h.seedAppWithBlueprint(doc, {
		id: APP,
		owner: PUBLISHER,
		projectId: PROJECT,
	});
	return { doc, copy };
}

function publish(doc: BlueprintDoc): Promise<PublishOutcome> {
	return publishAppToHq({
		scope: {
			appId: APP,
			projectId: PROJECT,
			actorUserId: PUBLISHER,
			role: "editor",
		},
		...TARGET,
		doc,
		compiledAtSeq: 0,
		reloadHead: reloadHeadFor(APP, PUBLISHER),
		appName: doc.appName,
		confirm: CONFIRM_ALL,
	});
}

function refusal(outcome: PublishOutcome) {
	if (outcome.landed) throw new Error("Expected the publish to stop");
	return outcome.refusal;
}

/**
 * The answers a first publish gets that creates `table` in the target from
 * Nova's copy: no table under its tag, then the table, read back once the
 * workbook is taken.
 */
function createPushingTable(
	peer: Parameters<typeof acceptImport>[0],
	table: ServedTable,
): void {
	serveTableList(peer, DOMAIN, []);
	acceptImport(peer, DOMAIN, 201);
	serveSource(peer, DOMAIN, "source-shell");
	takeWorkbook(peer, DOMAIN);
	serveTableList(peer, DOMAIN, [table]);
	serveRows(peer, DOMAIN, table);
	serveSource(peer, DOMAIN, "source-shell");
	acceptImport(peer, DOMAIN, 200);
	serveSource(peer, DOMAIN, "source-after-create-then-update");
}

/** The answers a first publish of an app holding no Project data CommCare HQ is sent gets. */
function createAndFill(peer: Parameters<typeof acceptImport>[0]): void {
	acceptImport(peer, DOMAIN, 201);
	serveSource(peer, DOMAIN, "source-shell");
	acceptImport(peer, DOMAIN, 200);
	serveSource(peer, DOMAIN, "source-after-create-then-update");
}

async function lookupMappings() {
	return h
		.db()
		.selectFrom("app_deployment_resources")
		.select(["nova_resource_id", "ownership", "adopted_at", "adopted_by"])
		.where("kind", "=", "lookup-table")
		.execute();
}

async function copyOf(copy: ManagedCopy) {
	const table = await getLookupTable(EDITOR_LOOKUP, copy.tableId);
	return {
		hq: table.hq,
		revisions: [table.definitionRevision, table.rowsRevision],
		rows: table.rows.map((row) => row.values),
	};
}

describe("a publish to the project space that manages the table", () => {
	it("sends no workbook and writes no mapping for a table it left as it is", async () => {
		const { doc } = await seedApp();
		await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [facilities]);
			serveRows(peer, DOMAIN, facilities);
			createAndFill(peer);
			const outcome = await publish(doc);
			expect(outcome.landed, JSON.stringify(outcome)).toBe(true);
			expect(
				outcome.checks.find((check) => check.id === "managed-data"),
			).toEqual({
				id: "managed-data",
				title: "Data managed in CommCare HQ",
				status: "passed",
				detail: managedDataPassed({ domain: DOMAIN, here: 1, elsewhere: 0 }),
				items: ["facilities"],
			});
			expect(outcome.checks.some((check) => check.id === "project-data")).toBe(
				false,
			);
			expect(publishRequests(peer)).toEqual([
				`GET ${TABLES}`,
				`GET ${ROWS}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
			]);
		});
		expect(await lookupMappings()).toEqual([]);
	});

	it("refreshes the copy before the export boundary reads it, so the app goes out over CommCare HQ's rows", async () => {
		// The copy holds no row: a choice list over it would never open, and
		// the boundary refuses it. CommCare HQ's table holds two.
		const { doc, copy } = await seedApp({ ...facilities, rows: [] });
		await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [facilities]);
			serveRows(peer, DOMAIN, facilities);
			createAndFill(peer);
			const outcome = await publish(doc);
			expect(outcome.landed, JSON.stringify(outcome)).toBe(true);
		});
		expect((await copyOf(copy)).rows).toHaveLength(2);
	});

	it("is refused by the boundary where CommCare HQ's table holds no row either", async () => {
		const empty = { ...facilities, rows: [] };
		const { doc } = await seedApp(empty);
		await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [empty]);
			serveRows(peer, DOMAIN, empty);
			const { failure } = refusal(await publish(doc));
			expect(failure.code).toBe("app_not_ready");
			// Project data refuses every edit to the table, so the item sends
			// the person where its rows are changed.
			expect(failure.details).toHaveLength(1);
			expect(failure.details[0]).toContain("which has no rows");
			expect(
				failure.details[0].endsWith(
					`CommCare HQ manages this table in ${DOMAIN}. You can add rows to it there, then refresh Nova's copy on the table's page, or choose another table for its choices.`,
				),
			).toBe(true);
			expect(failure.details[0]).not.toContain("Project data");
		});
	});

	it("stops before sending anything where a column the app reads is gone, the copy untouched", async () => {
		const { doc, copy } = await seedApp();
		const before = await copyOf(copy);
		const shrunk = {
			...facilities,
			fields: ["code"],
			rows: facilities.rows.map(({ code }) => ({ code })),
		};
		await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [shrunk]);
			serveRows(peer, DOMAIN, shrunk);
			expect(refusal(await publish(doc))).toMatchObject({
				phase: "preflight",
				failure: {
					code: "hq_managed_data_changed",
					message: MANAGED_DATA_CHANGED,
					details: [managedColumnGoneItem("name", "facilities", 1)],
				},
			});
			expect(publishRequests(peer)).toEqual([`GET ${TABLES}`, `GET ${ROWS}`]);
		});
		expect(await copyOf(copy)).toEqual(before);
	});

	it("stops where CommCare HQ refuses the rows read, naming the permissions it needs", async () => {
		const { doc } = await seedApp();
		await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [facilities]);
			refuseRows(peer, DOMAIN, facilities, 403);
			expect(refusal(await publish(doc)).failure).toEqual({
				code: "hq_resource_state_unknown",
				message: managedDataUnreadablePermission(DOMAIN),
				details: [],
			});
		});
	});
});

describe("Manage in Nova, and the publish after it", () => {
	it("stamps the definition and writes no row, so every open page refetches the table", async () => {
		const { copy } = await seedApp();
		const before = await getLookupManifest(EDITOR_LOOKUP);
		const rowsBefore = (await copyOf(copy)).rows;
		const outcome = await manageLookupTableInNova(ADMIN_LOOKUP, copy.tableId);
		if (!outcome.ok) throw new Error(outcome.message);
		const entryBefore = before.tables.find(
			(table) => table.id === copy.tableId,
		);
		expect(BigInt(outcome.table.tableRevision)).toBeGreaterThan(
			BigInt(entryBefore?.tableRevision ?? "0"),
		);
		expect(outcome.table.hq).toMatchObject({
			managedBy: "nova",
			takenOverBy: ADMIN,
		});
		expect((await copyOf(copy)).rows).toEqual(rowsBefore);
		// An editor may not choose it.
		expect(
			await manageLookupTableInNova(EDITOR_LOOKUP, copy.tableId),
		).toMatchObject({ ok: false, reason: "not-permitted" });
	});

	it("pushes the table as adopted by the person who took it over, at that moment", async () => {
		const { doc, copy } = await seedApp();
		const taken = await manageLookupTableInNova(ADMIN_LOOKUP, copy.tableId);
		if (!taken.ok) throw new Error(taken.message);
		await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [facilities]);
			serveRows(peer, DOMAIN, facilities);
			acceptImport(peer, DOMAIN, 201);
			serveSource(peer, DOMAIN, "source-shell");
			takeWorkbook(peer, DOMAIN);
			serveTableList(peer, DOMAIN, [facilities]);
			serveRows(peer, DOMAIN, facilities);
			serveSource(peer, DOMAIN, "source-shell");
			acceptImport(peer, DOMAIN, 200);
			serveSource(peer, DOMAIN, "source-after-create-then-update");
			const outcome = await publish(doc);
			expect(outcome.landed, JSON.stringify(outcome)).toBe(true);
			expect(publishRequests(peer)).toEqual([
				`GET ${TABLES}`,
				`GET ${ROWS}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
				`POST ${WORKBOOK}`,
				`GET ${TABLES}`,
				`GET ${ROWS}`,
				`GET ${SOURCE}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
			]);
		});
		const [mapping] = await lookupMappings();
		expect(mapping).toMatchObject({
			nova_resource_id: copy.tableId,
			ownership: "adopted",
			adopted_by: ADMIN,
		});
		expect(mapping?.adopted_at?.toISOString()).toBe(
			taken.table.hq?.takenOverAt,
		);
	});

	it("stops with the change first where CommCare HQ's rows moved since the last refresh, and names the hand-back", async () => {
		const { doc, copy } = await seedApp();
		const taken = await manageLookupTableInNova(ADMIN_LOOKUP, copy.tableId);
		if (!taken.ok) throw new Error(taken.message);
		const moved = {
			...facilities,
			rows: [{ code: "001", name: "North (renamed in HQ)" }],
		};
		await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [moved]);
			serveRows(peer, DOMAIN, moved);
			const stopped = refusal(await publish(doc));
			expect(stopped.failure.code).toBe("hq_changed");
			expect(stopped.remoteChanges).toEqual([
				expect.objectContaining({
					kind: "lookup-table",
					novaResourceId: copy.tableId,
					baselineKnown: true,
				}),
			]);
			expect(stopped.remoteChanges[0]?.parts.at(-1)).toBe(HAND_BACK_OFFERED);
			expect(publishRequests(peer)).toEqual([`GET ${TABLES}`, `GET ${ROWS}`]);
		});
	});

	it("takes CommCare HQ's rows on the hand-back, and the next publish leaves the table out", async () => {
		const { doc, copy } = await seedApp();
		const taken = await manageLookupTableInNova(ADMIN_LOOKUP, copy.tableId);
		if (!taken.ok) throw new Error(taken.message);
		const now = {
			...facilities,
			rows: [{ code: "009", name: "Only row" }],
		};
		await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [now]);
			serveRows(peer, DOMAIN, now);
			const back = await letHqManageLookupTable(ADMIN_LOOKUP, copy.tableId);
			if (!back.ok) throw new Error(back.message);
			expect(back.table.hq?.managedBy).toBe("commcare-hq");
		});
		expect((await copyOf(copy)).rows).toEqual([
			{ [copy.columns.code]: "009", [copy.columns.name]: "Only row" },
		]);
		await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [now]);
			serveRows(peer, DOMAIN, now);
			createAndFill(peer);
			expect((await publish(doc)).landed).toBe(true);
			expect(publishRequests(peer)).not.toContain(`POST ${WORKBOOK}`);
		});
	});

	it("stops before the workbook where the table was handed back while the publish got ready", async () => {
		const { doc, copy } = await seedApp();
		const taken = await manageLookupTableInNova(ADMIN_LOOKUP, copy.tableId);
		if (!taken.ok) throw new Error(taken.message);
		await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [facilities]);
			serveRows(peer, DOMAIN, facilities);
			// Preflight has passed when the empty app is made: the hand-back
			// lands in that moment, as a second tab's would.
			acceptImport(peer, DOMAIN, 201, {
				before: async () => {
					await h
						.db()
						.updateTable("lookup_tables")
						.set({ hq_taken_over_at: null, hq_taken_over_by: null })
						.where("id", "=", copy.tableId)
						.execute();
				},
			});
			serveSource(peer, DOMAIN, "source-shell");
			expect(refusal(await publish(doc))).toMatchObject({
				phase: "resources",
				failure: {
					code: "managed_table_handed_back",
					message: MANAGED_TABLE_HANDED_BACK_AFTER_CREATE,
				},
			});
			expect(publishRequests(peer)).toEqual([
				`GET ${TABLES}`,
				`GET ${ROWS}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
			]);
		});
		expect(await lookupMappings()).toEqual([]);
	});

	it("names no hand-back where CommCare HQ deleted the table, since nothing is there to take", async () => {
		const { doc, copy } = await seedApp();
		const taken = await manageLookupTableInNova(ADMIN_LOOKUP, copy.tableId);
		if (!taken.ok) throw new Error(taken.message);
		await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [facilities]);
			serveRows(peer, DOMAIN, facilities);
			acceptImport(peer, DOMAIN, 201);
			serveSource(peer, DOMAIN, "source-shell");
			takeWorkbook(peer, DOMAIN);
			serveTableList(peer, DOMAIN, [facilities]);
			serveRows(peer, DOMAIN, facilities);
			serveSource(peer, DOMAIN, "source-shell");
			acceptImport(peer, DOMAIN, 200);
			serveSource(peer, DOMAIN, "source-after-create-then-update");
			expect((await publish(doc)).landed).toBe(true);
		});
		await withHttpPeer(async (peer) => {
			serveSource(peer, DOMAIN, "source-after-create-then-update");
			serveTableList(peer, DOMAIN, []);
			const stopped = refusal(await publish(doc));
			expect(stopped.failure.code).toBe("hq_changed");
			expect(stopped.remoteChanges).toEqual([
				expect.objectContaining({
					kind: "lookup-table",
					novaResourceId: copy.tableId,
				}),
			]);
			expect(stopped.remoteChanges[0]?.parts).not.toContain(HAND_BACK_OFFERED);
		});
	});

	it("names no hand-back for a table taken over from another project space that changed in this one", async () => {
		await members();
		const copy = await makeManagedCopy(h, EDITOR_LOOKUP, facilities, {
			server: "india",
			domain: "north",
		});
		const doc = readerOf([copy]);
		await h.seedAppWithBlueprint(doc, {
			id: APP,
			owner: PUBLISHER,
			projectId: PROJECT,
		});
		const taken = await manageLookupTableInNova(ADMIN_LOOKUP, copy.tableId);
		if (!taken.ok) throw new Error(taken.message);
		await withHttpPeer(async (peer) => {
			createPushingTable(peer, facilities);
			const outcome = await publish(doc);
			expect(outcome.landed, JSON.stringify(outcome)).toBe(true);
		});
		const moved = {
			...facilities,
			rows: [{ code: "001", name: "North (renamed in HQ)" }],
		};
		await withHttpPeer(async (peer) => {
			serveSource(peer, DOMAIN, "source-after-create-then-update");
			serveTableList(peer, DOMAIN, [moved]);
			serveRows(peer, DOMAIN, moved);
			const stopped = refusal(await publish(doc));
			expect(stopped.failure.code).toBe("hq_changed");
			expect(stopped.remoteChanges[0]?.parts.length).toBeGreaterThan(0);
			// The hand-back would take north's version, not this change.
			expect(stopped.remoteChanges[0]?.parts).not.toContain(HAND_BACK_OFFERED);
		});
	});
});

describe("a publish of a table another project space manages", () => {
	it("says the publish puts Nova's copy there, and sends it in the workbook", async () => {
		// The publisher's connection is approved for the target alone, so the
		// table's own project space can't be read: the copy goes as it is.
		await members();
		const copy = await makeManagedCopy(h, EDITOR_LOOKUP, facilities, {
			server: "india",
			domain: "north",
		});
		const doc = readerOf([copy]);
		await h.seedAppWithBlueprint(doc, {
			id: APP,
			owner: PUBLISHER,
			projectId: PROJECT,
		});
		const refreshedAt = (await copyOf(copy)).hq?.refreshedAt ?? "";
		await withHttpPeer(async (peer) => {
			createPushingTable(peer, facilities);
			const outcome = await publish(doc);
			expect(outcome.landed, JSON.stringify(outcome)).toBe(true);
			expect(
				outcome.checks.find((check) => check.id === "managed-data"),
			).toMatchObject({
				status: "passed",
				detail: managedDataPassed({ domain: DOMAIN, here: 0, elsewhere: 1 }),
				items: [
					managedTableFromElsewhereItem(
						"facilities",
						"north",
						driftDate(refreshedAt),
						DOMAIN,
					),
				],
			});
			expect(publishRequests(peer)).toContain(`POST ${WORKBOOK}`);
		});
	});
});

describe("Refresh from CommCare HQ, through its service", () => {
	it("takes CommCare HQ's changed rows", async () => {
		const { copy } = await seedApp();
		const grown = {
			...facilities,
			rows: [...facilities.rows, { code: "003", name: "East" }],
		};
		const outcome = await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [grown]);
			serveRows(peer, DOMAIN, grown);
			return refreshManagedLookupTable(EDITOR_LOOKUP, copy.tableId);
		});
		expect(outcome).toMatchObject({ ok: true, receipt: { changed: "rows" } });
		expect((await copyOf(copy)).rows).toHaveLength(3);
	});

	const refusals: readonly [
		string,
		ServedTable | null,
		{ reason: string; message: string },
	][] = [
		[
			"a table gone",
			null,
			{ reason: "table-gone", message: managedTableGone("facilities", DOMAIN) },
		],
		[
			"a field property",
			{ ...facilities, fieldProperties: { name: ["lang"] } },
			{
				reason: "unsupported",
				message: managedTableUnsupported("field properties"),
			},
		],
		[
			"a table over a cap",
			{ ...facilities, rows: [{ code: "001", name: "n".repeat(70_000) }] },
			{ reason: "over-cap", message: expect.stringContaining("in one cell") },
		],
		[
			"a table with no columns",
			{ ...facilities, fields: [], rows: [] },
			{ reason: "unsupported", message: MANAGED_TABLE_NO_COLUMNS },
		],
		[
			"a character XML can't carry",
			{ ...facilities, rows: [{ code: "001", name: "North\u0002" }] },
			{
				reason: "unrepresentable-text",
				message: managedTableUnrepresentable("name"),
			},
		],
	];

	it.each(refusals)(
		"leaves the copy as it was for %s",
		async (_label, served, expected) => {
			const { copy } = await seedApp();
			const before = await copyOf(copy);
			const outcome = await withHttpPeer(async (peer) => {
				serveTableList(peer, DOMAIN, served === null ? [] : [served]);
				if (served !== null) serveRows(peer, DOMAIN, served);
				return refreshManagedLookupTable(EDITOR_LOOKUP, copy.tableId);
			});
			expect(outcome).toEqual({ ok: false, ...expected });
			expect(await copyOf(copy)).toEqual(before);
		},
	);

	it("refuses the hand-back of a table that now holds no columns, leaving Nova's copy as it was", async () => {
		const { copy } = await seedApp();
		const taken = await manageLookupTableInNova(ADMIN_LOOKUP, copy.tableId);
		if (!taken.ok) throw new Error(taken.message);
		const before = await copyOf(copy);
		const bare = { ...facilities, fields: [], rows: [] };
		const outcome = await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [bare]);
			serveRows(peer, DOMAIN, bare);
			return letHqManageLookupTable(ADMIN_LOOKUP, copy.tableId);
		});
		expect(outcome).toEqual({
			ok: false,
			reason: "unsupported",
			message: MANAGED_TABLE_NO_COLUMNS,
		});
		expect(await copyOf(copy)).toEqual(before);
	});

	it("answers a table removed while CommCare HQ was read as not there", async () => {
		// No app reads this copy, so a person may remove it at any moment.
		await members();
		const copy = await makeManagedCopy(h, EDITOR_LOOKUP, facilities, TARGET);
		const outcome = await withHttpPeer(async (peer) => {
			peer
				.get(HOST)
				.intercept({
					path: TABLES,
					method: "GET",
					headers: { authorization: "ApiKey account:fixture-key" },
				})
				.reply(async () => {
					await h
						.db()
						.deleteFrom("lookup_tables")
						.where("id", "=", copy.tableId)
						.execute();
					return {
						statusCode: 200,
						data: JSON.stringify({
							meta: { next: null },
							objects: [
								{
									id: facilities.id,
									tag: facilities.tag,
									is_global: true,
									fields: facilities.fields.map((field) => ({
										field_name: field,
										properties: [],
									})),
								},
							],
						}),
					};
				});
			serveRows(peer, DOMAIN, facilities);
			return refreshManagedLookupTable(EDITOR_LOOKUP, copy.tableId);
		});
		expect(outcome).toEqual({
			ok: false,
			reason: "not-found",
			message: LOOKUP_TABLE_NOT_FOUND,
		});
	});

	it("cannot read where CommCare HQ refuses the rows", async () => {
		const { copy } = await seedApp();
		const outcome = await withHttpPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [facilities]);
			refuseRows(peer, DOMAIN, facilities, 403);
			return refreshManagedLookupTable(EDITOR_LOOKUP, copy.tableId);
		});
		expect(outcome).toEqual({
			ok: false,
			reason: "cannot-read",
			message: cannotReadManagedTables(DOMAIN),
		});
	});

	it("cannot read with a connection on another server, and asks for one where there is none", async () => {
		const { copy } = await seedApp();
		await h
			.db()
			.updateTable("user_settings")
			.set({ commcare_server: "eu" })
			.where("user_id", "=", PUBLISHER)
			.execute();
		expect(
			await withHttpPeer(() =>
				refreshManagedLookupTable(EDITOR_LOOKUP, copy.tableId),
			),
		).toEqual({
			ok: false,
			reason: "cannot-read",
			message: cannotReadManagedTables(DOMAIN),
		});
		await h
			.db()
			.deleteFrom("user_settings")
			.where("user_id", "=", PUBLISHER)
			.execute();
		expect(
			await withHttpPeer(() =>
				refreshManagedLookupTable(EDITOR_LOOKUP, copy.tableId),
			),
		).toEqual({
			ok: false,
			reason: "not-connected",
			message: CONNECT_TO_REFRESH_TABLE,
		});
	});
});
