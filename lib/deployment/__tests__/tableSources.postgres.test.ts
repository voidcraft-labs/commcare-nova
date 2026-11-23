import { publishFromSession as publishAppToHq } from "@/lib/deployment/__tests__/publishWithGrant";
/**
 * Use the table from CommCare HQ and Create a separate table, through their
 * services and the publish that leads to them, over real Postgres and a peer
 * standing in for CommCare HQ (`managedFixtures.ts`).
 *
 * Use the table from CommCare HQ turns a table made in Nova, which a publish
 * put in a project space, into Nova's copy of the table there: a publish puts
 * it there first, CommCare HQ's table changes, the publish stops and names
 * the action, and the next publish leaves the table as it is. Create a
 * separate table makes a new table from what one holds and rebinds the apps
 * chosen, the old table and the other app staying as they were.
 */

import { sql } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp, repairLookupReferenceEdges } from "@/lib/db/apps";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import {
	type LookupColumnId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { applyLookupAuthoringBatchInTransaction } from "@/lib/lookup/authoringBatch";
import { getLookupTable, updateLookupRow } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";
import { authorizeLookupWriteInTransaction } from "@/lib/lookup/writerTransaction";
import {
	MANAGEMENT_NEEDS_ADMIN,
	MANAGEMENT_REVIEW_MOVED,
	REFRESH_NEEDS_EDITOR,
	SEPARATE_TABLE_ASSIGNED,
	SEPARATE_TABLE_INDEXES,
	SEPARATE_TABLE_NO_ROOM,
	SEPARATE_TABLE_ROWS_UNAVAILABLE,
	takeHqTableBody,
	USE_HQ_TABLE_NO_SOURCE,
	USE_HQ_TABLE_OFFERED,
} from "@/lib/publish/managedData";
import { PLAN_FEATURE_IDS } from "@/lib/publish/planFeatures";
import {
	readHqTableSourcesView,
	reviewUseHqTable,
	takeHqTableForLookupTable,
} from "../managedData";
import { reviewSeparateTable, separateLookupTable } from "../separateTable";
import type { PublishOutcome } from "../service";
import type { DeploymentConfirmationKey } from "../types";
import {
	acceptImport,
	connect,
	hqSaves,
	type ManagedCopy,
	makeManagedCopy,
	publishRequests,
	readerOf,
	rowsPath,
	type ServedTable,
	serveRows,
	serveSource,
	serveTableList,
	tablesPath,
	takeWorkbook,
	withManagedPeer,
} from "./managedFixtures";
import { reloadHeadFor } from "./publishFixtures";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
beforeEach(() => {
	hqSaves.reset();
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});

const h = setupAppStateTestDb("table_sources_", { authSchema: "migrated" });
const APP = "visits-app";
const OTHER_APP = "stock-app";
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

const facilities: ServedTable = {
	id: "a".repeat(32),
	tag: "facilities",
	fields: ["code", "name"],
	rows: [
		{ code: "001", name: "North" },
		{ code: "002", name: "South" },
	],
};

const CONFIRM_ALL: readonly DeploymentConfirmationKey[] = [
	...PLAN_FEATURE_IDS.map((subject) => ({
		kind: "plan-feature" as const,
		subject,
	})),
	{ kind: "flat-location-fixture" },
	{ kind: "connect-forwarder" },
	{ kind: "form-entry-sync-off" },
];

async function members(): Promise<void> {
	await h.seedProjectMember(PUBLISHER, PROJECT, "editor");
	await h.seedProjectMember(ADMIN, PROJECT, "admin");
	await connect(h, PUBLISHER, "india", [DOMAIN]);
	await connect(h, ADMIN, "india", [DOMAIN, "north"]);
}

/** A table made in Nova with `served`'s columns and rows, every column text. */
async function makeNovaTable(served: ServedTable): Promise<ManagedCopy> {
	const receipt = await h.withTransaction(async (tx) =>
		applyLookupAuthoringBatchInTransaction(
			tx,
			await authorizeLookupWriteInTransaction(tx, EDITOR_LOOKUP, "edit"),
			{
				createTables: [
					{
						key: "table",
						name: served.tag,
						tag: served.tag,
						columns: served.fields.map((field) => ({
							key: field,
							wireName: field,
							label: field,
							dataType: "text" as const,
						})),
						rows: served.rows.map((row, index) => ({
							key: `row-${index}`,
							cells: served.fields.map((field) => ({
								columnKey: field,
								value: row[field] ?? "",
							})),
						})),
					},
				],
			},
		),
	);
	const [table] = receipt.tables;
	if (table === undefined) throw new Error("The batch made no table.");
	return {
		tableId: lookupTableIdSchema.parse(table.tableId),
		columns: Object.fromEntries(
			table.columnIds.map(({ key, id }) => [
				key,
				lookupColumnIdSchema.parse(id),
			]),
		) as Record<string, LookupColumnId>,
	};
}

async function seedReader(
	doc: BlueprintDoc,
	id: string,
): Promise<BlueprintDoc> {
	await h.seedAppWithBlueprint(doc, {
		id,
		owner: PUBLISHER,
		projectId: PROJECT,
	});
	await repairLookupReferenceEdges(id);
	return doc;
}

function publish(doc: BlueprintDoc, appId = APP): Promise<PublishOutcome> {
	return publishAppToHq({
		requireHqImport: null,
		scope: {
			appId,
			projectId: PROJECT,
			actorUserId: PUBLISHER,
			role: "editor",
		},
		...TARGET,
		doc,
		compiledAtSeq: 0,
		reloadHead: reloadHeadFor(appId, PUBLISHER),
		appName: doc.appName,
		confirm: CONFIRM_ALL,
	});
}

function refusal(outcome: PublishOutcome) {
	if (outcome.landed) throw new Error("Expected the publish to stop");
	return outcome.refusal;
}

/** The answers a first publish gets that creates `table` in the target from Nova's table. */
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

async function liveMappings() {
	return h
		.db()
		.selectFrom("app_deployment_resources")
		.select(["nova_resource_id", "remote_id", "superseded_at"])
		.where("kind", "=", "lookup-table")
		.execute();
}

const moved: ServedTable = {
	...facilities,
	rows: [{ code: "001", name: "North (renamed in HQ)" }],
};

/** A Nova table an app reads, published to the target once. */
async function published(): Promise<{ doc: BlueprintDoc; table: ManagedCopy }> {
	await members();
	const table = await makeNovaTable(facilities);
	const doc = await seedReader(readerOf([table]), APP);
	await withManagedPeer(async (peer) => {
		createPushingTable(peer, facilities);
		const outcome = await publish(doc);
		expect(outcome.landed, JSON.stringify(outcome)).toBe(true);
	});
	return { doc, table };
}

describe("Use the table from CommCare HQ", () => {
	it("is named by the publish that met a change made in CommCare HQ, takes that table, and the next publish leaves it as it is", async () => {
		const { doc, table } = await published();
		expect(await liveMappings()).toEqual([
			{
				nova_resource_id: table.tableId,
				remote_id: facilities.id,
				superseded_at: null,
			},
		]);

		await withManagedPeer(async (peer) => {
			serveSource(peer, DOMAIN, "source-after-create-then-update");
			serveTableList(peer, DOMAIN, [moved]);
			serveRows(peer, DOMAIN, moved);
			const stopped = refusal(await publish(doc));
			expect(stopped.failure.code).toBe("hq_changed");
			expect(stopped.remoteChanges[0]?.parts.at(-1)).toBe(USE_HQ_TABLE_OFFERED);
		});

		const view = await readHqTableSourcesView(EDITOR_LOOKUP, table.tableId);
		expect(view?.sources).toEqual([
			expect.objectContaining({
				server: "india",
				domain: DOMAIN,
				remoteId: facilities.id,
				appIds: [APP],
				connected: true,
			}),
		]);

		const review = await withManagedPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [moved]);
			serveRows(peer, DOMAIN, moved);
			return reviewUseHqTable(ADMIN_LOOKUP, table.tableId, TARGET);
		});
		if (!review.ok) throw new Error(review.message);
		expect(review.review.lines[0]).toBe(takeHqTableBody(DOMAIN));
		expect(review.review.lines).toContain(
			"The table there has 1 row, and Nova's has 2.",
		);

		const outcome = await withManagedPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [moved]);
			serveRows(peer, DOMAIN, moved);
			return takeHqTableForLookupTable(
				ADMIN_LOOKUP,
				table.tableId,
				TARGET,
				review.review.reviewDigest,
			);
		});
		expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
		const copy = await getLookupTable(EDITOR_LOOKUP, table.tableId);
		expect(copy.hq).toMatchObject({
			managedBy: "commcare-hq",
			server: "india",
			domain: DOMAIN,
		});
		expect(copy.rows.map((row) => Object.values(row.values))).toEqual([
			["001", "North (renamed in HQ)"],
		]);

		/* The table keeps its id, so the app is unchanged, and the target now
		 * manages it: the publish reads it, sends no workbook, and supersedes
		 * the mapping it no longer pushes. */
		await withManagedPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [moved]);
			serveRows(peer, DOMAIN, moved);
			serveSource(peer, DOMAIN, "source-after-create-then-update");
			acceptImport(peer, DOMAIN, 200);
			serveSource(peer, DOMAIN, "source-after-create-then-update");
			const outcome = await publish(doc);
			expect(outcome.landed, JSON.stringify(outcome)).toBe(true);
			expect(
				publishRequests(peer).filter((line) => line.includes("fixapi")),
			).toEqual([]);
		});
		const [mapping] = await liveMappings();
		expect(mapping?.superseded_at).not.toBeNull();
	});

	it("is an admin's to choose, and changes nothing where the table moved after the review", async () => {
		const { table } = await published();
		await withManagedPeer(async (peer) => {
			expect(
				await reviewUseHqTable(EDITOR_LOOKUP, table.tableId, TARGET),
			).toEqual({
				ok: false,
				reason: "not-permitted",
				message: MANAGEMENT_NEEDS_ADMIN,
			});
			expect(publishRequests(peer)).toEqual([]);
		});
		const review = await withManagedPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [moved]);
			serveRows(peer, DOMAIN, moved);
			return reviewUseHqTable(ADMIN_LOOKUP, table.tableId, TARGET);
		});
		if (!review.ok) throw new Error(review.message);
		const before = await getLookupTable(EDITOR_LOOKUP, table.tableId);
		const [row] = before.rows;
		if (row === undefined) throw new Error("No row to edit.");
		const code = table.columns.code;
		const name = table.columns.name;
		if (code === undefined || name === undefined)
			throw new Error("The table has no code and name.");
		await updateLookupRow(EDITOR_LOOKUP, {
			tableId: table.tableId,
			rowId: row.id,
			expectedTableRevision: before.tableRevision,
			values: { [code]: "001", [name]: "North (edited in Nova)" },
		});
		const outcome = await withManagedPeer(async (peer) => {
			serveTableList(peer, DOMAIN, [moved]);
			serveRows(peer, DOMAIN, moved);
			return takeHqTableForLookupTable(
				ADMIN_LOOKUP,
				table.tableId,
				TARGET,
				review.review.reviewDigest,
			);
		});
		expect(outcome).toEqual({
			ok: false,
			reason: "review-moved",
			message: MANAGEMENT_REVIEW_MOVED,
		});
		expect((await getLookupTable(EDITOR_LOOKUP, table.tableId)).hq).toBe(
			undefined,
		);
	});

	it("names no source where no publish holds the table, and none for a table that came from CommCare HQ", async () => {
		await members();
		const table = await makeNovaTable(facilities);
		await seedReader(readerOf([table]), APP);
		expect(
			(await readHqTableSourcesView(EDITOR_LOOKUP, table.tableId))?.sources,
		).toEqual([]);
		expect(await reviewUseHqTable(ADMIN_LOOKUP, table.tableId, TARGET)).toEqual(
			{
				ok: false,
				reason: "not-found",
				message: USE_HQ_TABLE_NO_SOURCE,
			},
		);
		const copy = await makeManagedCopy(
			h,
			EDITOR_LOOKUP,
			{ ...facilities, tag: "districts" },
			{ server: "india", domain: "north" },
		);
		expect(await readHqTableSourcesView(EDITOR_LOOKUP, copy.tableId)).toBe(
			null,
		);
	});
});

describe("Create a separate table", () => {
	/** Two apps reading Nova's copy of a table `north` manages, whose indexes CommCare HQ never showed. */
	async function shared(): Promise<{
		copy: ManagedCopy;
		visits: BlueprintDoc;
	}> {
		await members();
		const copy = await makeManagedCopy(h, EDITOR_LOOKUP, facilities, {
			server: "india",
			domain: "north",
		});
		const visits = await seedReader(readerOf([copy]), APP);
		await seedReader(readerOf([copy], "Stock counts"), OTHER_APP);
		return { copy, visits };
	}

	it("makes a Nova table from the copy, rebinds the chosen app only, and that app's publish sends the new table", async () => {
		const { copy, visits } = await shared();
		await withManagedPeer(async (peer) => {
			const stopped = refusal(await publish(visits));
			expect(stopped.failure.code).toBe("app_not_ready");
			expect(stopped.failure.details).toEqual([
				"“facilities” needs a verified data source for this destination. You can prepare its table in the project space, or create a separate table on its page in Project data.",
			]);
			expect(publishRequests(peer)).toEqual([]);
		});

		const review = await reviewSeparateTable(EDITOR_LOOKUP, copy.tableId);
		if (!review.ok) throw new Error(review.message);
		expect(review.review.lines).toContain(SEPARATE_TABLE_INDEXES);
		expect(review.review.suggested).toEqual({
			name: "facilities 2",
			tag: "facilities_2",
		});
		expect(review.review.apps.map((app) => app.appId).sort()).toEqual(
			[APP, OTHER_APP].sort(),
		);

		const outcome = await separateLookupTable(EDITOR_LOOKUP, copy.tableId, {
			name: "Clinic facilities",
			tag: "clinic_facilities",
			appIds: [APP],
			reviewDigest: review.review.reviewDigest,
		});
		if (!outcome.ok) throw new Error(outcome.message);
		const newTableId = lookupTableIdSchema.parse(outcome.table.id);

		const made = await getLookupTable(EDITOR_LOOKUP, newTableId);
		expect(made).toMatchObject({
			name: "Clinic facilities",
			tag: "clinic_facilities",
		});
		expect(made.hq).toBe(undefined);
		expect(
			made.columns.map((column) => [column.wireName, column.index]),
		).toEqual([
			["code", undefined],
			["name", undefined],
		]);
		expect(made.rows.map((row) => Object.values(row.values))).toEqual([
			["001", "North"],
			["002", "South"],
		]);

		const rebound = await loadApp(APP);
		const kept = await loadApp(OTHER_APP);
		if (rebound === null || kept === null) throw new Error("An app is gone.");
		const targets = (doc: typeof rebound.blueprint) =>
			extractLookupReferenceTargets(hydratePersistedBlueprint(doc)).tableIds;
		expect(targets(rebound.blueprint)).toEqual([newTableId]);
		expect(targets(kept.blueprint)).toEqual([copy.tableId]);
		const edges = await sql<{ app_id: string; table_id: string }>`
			SELECT app_id, table_id FROM lookup_table_references ORDER BY app_id`.execute(
			h.db(),
		);
		expect(edges.rows).toEqual([
			{ app_id: OTHER_APP, table_id: copy.tableId },
			{ app_id: APP, table_id: newTableId },
		]);
		/* The old copy is as it was: same origin, same revisions. */
		expect(
			(await getLookupTable(EDITOR_LOOKUP, copy.tableId)).hq,
		).toMatchObject({
			managedBy: "commcare-hq",
			domain: "north",
		});

		const separate: ServedTable = {
			...facilities,
			id: "b".repeat(32),
			tag: "clinic_facilities",
		};
		await withManagedPeer(async (peer) => {
			createPushingTable(peer, separate);
			const landed = await publishAppToHq({
				requireHqImport: null,
				scope: {
					appId: APP,
					projectId: PROJECT,
					actorUserId: PUBLISHER,
					role: "editor",
				},
				...TARGET,
				doc: hydratePersistedBlueprint(rebound.blueprint),
				compiledAtSeq: rebound.mutation_seq,
				reloadHead: reloadHeadFor(APP, PUBLISHER),
				appName: rebound.blueprint.appName,
				confirm: CONFIRM_ALL,
			});
			expect(landed.landed, JSON.stringify(landed)).toBe(true);
			expect(publishRequests(peer)).toContain(
				`GET ${rowsPath(DOMAIN, separate)}`,
			);
			expect(publishRequests(peer)).toContain(`GET ${tablesPath(DOMAIN)}`);
		});
	});

	it("changes nothing where another app started reading the table after the review, or for a viewer", async () => {
		const { copy } = await shared();
		const review = await reviewSeparateTable(EDITOR_LOOKUP, copy.tableId);
		if (!review.ok) throw new Error(review.message);
		await seedReader(readerOf([copy], "Referrals"), "referrals-app");
		expect(
			await separateLookupTable(EDITOR_LOOKUP, copy.tableId, {
				name: "Clinic facilities",
				tag: "clinic_facilities",
				appIds: [APP],
				reviewDigest: review.review.reviewDigest,
			}),
		).toEqual({
			ok: false,
			reason: "review-moved",
			message: MANAGEMENT_REVIEW_MOVED,
		});
		expect(
			await separateLookupTable(
				{ ...EDITOR_LOOKUP, role: "viewer" },
				copy.tableId,
				{
					name: "Clinic facilities",
					tag: "clinic_facilities",
					appIds: [APP],
					reviewDigest: review.review.reviewDigest,
				},
			),
		).toEqual({
			ok: false,
			reason: "not-permitted",
			message: REFRESH_NEEDS_EDITOR,
		});
		const tables = await h
			.db()
			.selectFrom("lookup_tables")
			.select("tag")
			.execute();
		expect(tables.map((table) => table.tag)).toEqual(["facilities"]);
		const app = await loadApp(APP);
		if (app === null) throw new Error("The app is gone.");
		expect(
			extractLookupReferenceTargets(hydratePersistedBlueprint(app.blueprint))
				.tableIds,
		).toEqual([copy.tableId]);
	});

	it("carries row details, repeated values and their details into the new table exactly", async () => {
		await members();
		const receipt = await h.withTransaction(async (tx) =>
			applyLookupAuthoringBatchInTransaction(
				tx,
				await authorizeLookupWriteInTransaction(tx, EDITOR_LOOKUP, "edit"),
				{
					createTables: [
						{
							key: "table",
							name: "districts",
							tag: "districts",
							attributes: [{ wireName: "zone", label: "Zone" }],
							columns: [
								{
									key: "code",
									wireName: "code",
									label: "code",
									dataType: "text",
								},
								{
									key: "name",
									wireName: "name",
									label: "name",
									dataType: "text",
								},
								{
									key: "alias",
									wireName: "alias",
									label: "alias",
									dataType: "text",
									repeated: true,
									properties: [{ wireName: "lang", label: "Language" }],
								},
							],
							rows: [
								{
									key: "north",
									cells: [
										{ columnKey: "code", value: "007" },
										{ columnKey: "name", value: " North " },
									],
									content: {
										attributes: { zone: "a" },
										occurrences: {
											alias: [
												{ text: "Nord", properties: { lang: "fra" } },
												{ text: "Nord", properties: { lang: "deu" } },
												{ text: "", properties: {} },
											],
										},
									},
								},
								{
									key: "south",
									cells: [
										{ columnKey: "code", value: "1.50" },
										{ columnKey: "name", value: "South" },
									],
									content: {
										attributes: { zone: "b" },
										occurrences: { alias: [] },
									},
								},
							],
						},
					],
				},
			),
		);
		const [created] = receipt.tables;
		if (created === undefined) throw new Error("The batch made no table.");
		const tableId = lookupTableIdSchema.parse(created.tableId);
		const columns = Object.fromEntries(
			created.columnIds.map(({ key, id }) => [
				key,
				lookupColumnIdSchema.parse(id),
			]),
		) as Record<string, LookupColumnId>;
		const zone = (
			await getLookupTable(EDITOR_LOOKUP, tableId)
		).attributes?.find((member) => member.wireName === "zone")?.id;
		const code = columns.code;
		if (zone === undefined || code === undefined)
			throw new Error("The table has no zone detail or code column.");
		/* The question saves the code and shows the row's zone detail, a
		 * reference by the detail's own id. */
		await seedReader(
			buildDoc({
				appName: "Facility visits",
				modules: [
					{
						name: "Visits",
						forms: [
							{
								name: "Visit",
								type: "survey",
								fields: [
									{
										id: "district",
										kind: "single_select" as const,
										optionsSource: {
											kind: "lookup" as const,
											tableId,
											valueColumnId: code,
											labelColumnId: { attributeId: zone },
										},
									},
								],
							},
						],
					},
				],
			}),
			APP,
		);
		const review = await reviewSeparateTable(EDITOR_LOOKUP, tableId);
		if (!review.ok) throw new Error(review.message);
		expect(review.review.lines).not.toContain(SEPARATE_TABLE_INDEXES);
		const outcome = await separateLookupTable(EDITOR_LOOKUP, tableId, {
			...review.review.suggested,
			appIds: [APP],
			reviewDigest: review.review.reviewDigest,
		});
		if (!outcome.ok) throw new Error(outcome.message);
		/* The same content by name: each row's values, its detail, and every
		 * value of the repeated column in order with its own detail. */
		const named = async (id: string) => {
			const table = await getLookupTable(
				EDITOR_LOOKUP,
				lookupTableIdSchema.parse(id),
			);
			const wire = new Map(table.columns.map((c) => [c.id, c.wireName]));
			const members = new Map<string, string>([
				...(table.attributes ?? []).map((m) => [m.id, m.wireName] as const),
				...table.columns.flatMap((c) =>
					(c.properties ?? []).map((m) => [m.id, m.wireName] as const),
				),
			]);
			const rename = (
				record: Record<string, unknown> | undefined,
			): Record<string, unknown> =>
				Object.fromEntries(
					Object.entries(record ?? {}).map(([k, v]) => [
						wire.get(k as never) ?? members.get(k) ?? k,
						Array.isArray(v)
							? v.map(
									(o: {
										text: string;
										properties: Record<string, string>;
									}) => ({
										text: o.text,
										properties: rename(o.properties),
									}),
								)
							: v,
					]),
				);
			return table.rows.map((row) => ({
				values: rename(row.values),
				attributes: rename(row.attributes),
				occurrences: rename(row.occurrences as never),
			}));
		};
		expect(await named(outcome.table.id)).toEqual(await named(tableId));
		const newZone = (
			await getLookupTable(
				EDITOR_LOOKUP,
				lookupTableIdSchema.parse(outcome.table.id),
			)
		).attributes?.find((member) => member.wireName === "zone")?.id;
		const app = await loadApp(APP);
		if (app === null || newZone === undefined)
			throw new Error("The app or the new zone detail is gone.");
		const targets = extractLookupReferenceTargets(
			hydratePersistedBlueprint(app.blueprint),
		);
		expect(targets.tableIds).toEqual([outcome.table.id]);
		expect(targets.memberTargets?.map((target) => target.memberId)).toEqual([
			newZone,
		]);
		expect((await named(outcome.table.id))[0]).toEqual({
			values: { code: "007", name: " North " },
			attributes: { zone: "a" },
			occurrences: {
				alias: [
					{ text: "Nord", properties: { lang: "fra" } },
					{ text: "Nord", properties: { lang: "deu" } },
					{ text: "", properties: {} },
				],
			},
		});
	});

	it("refuses a copy whose current rows Nova doesn't hold by sending the person to refresh it, not as rows for certain workers", async () => {
		await members();
		const copy = await makeManagedCopy(h, EDITOR_LOOKUP, facilities, {
			server: "india",
			domain: "north",
		});
		await seedReader(readerOf([copy]), APP);
		/* Every worker receives the table, but the copy's inventory is not
		 * current, as a source read without its rows leaves it. */
		await sql`UPDATE lookup_tables SET hq_canonical = jsonb_set(hq_canonical, '{source,inventory}', '"unavailable"') WHERE id = ${copy.tableId}`.execute(
			h.db(),
		);
		expect(await reviewSeparateTable(EDITOR_LOOKUP, copy.tableId)).toEqual({
			ok: false,
			reason: "unsupported",
			message: SEPARATE_TABLE_ROWS_UNAVAILABLE,
		});
	});

	it("says the Project has no room for the copy, writing nothing, where its lookup storage would run out", async () => {
		const { copy } = await shared();
		const review = await reviewSeparateTable(EDITOR_LOOKUP, copy.tableId);
		if (!review.ok) throw new Error(review.message);
		const full =
			await sql`UPDATE lookup_storage_budgets SET capacity_bytes = used_bytes WHERE project_id = ${PROJECT}`.execute(
				h.db(),
			);
		expect(Number(full.numAffectedRows)).toBe(1);
		expect(
			await separateLookupTable(EDITOR_LOOKUP, copy.tableId, {
				name: "Clinic facilities",
				tag: "clinic_facilities",
				appIds: [APP],
				reviewDigest: review.review.reviewDigest,
			}),
		).toEqual({
			ok: false,
			reason: "unsupported",
			message: SEPARATE_TABLE_NO_ROOM,
		});
		const tables = await h
			.db()
			.selectFrom("lookup_tables")
			.select("tag")
			.execute();
		expect(tables.map((table) => table.tag)).toEqual(["facilities"]);
	});

	it("refuses a table whose rows go to certain workers", async () => {
		await members();
		const copy = await makeManagedCopy(
			h,
			EDITOR_LOOKUP,
			{ ...facilities, isGlobal: false },
			{ server: "india", domain: "north" },
		);
		await seedReader(readerOf([copy]), APP);
		const review = await reviewSeparateTable(EDITOR_LOOKUP, copy.tableId);
		expect(review).toEqual({
			ok: false,
			reason: "unsupported",
			message: SEPARATE_TABLE_ASSIGNED,
		});
	});
});
