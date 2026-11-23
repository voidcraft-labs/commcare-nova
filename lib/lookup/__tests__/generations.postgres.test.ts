import { sql } from "kysely";
import { v7 } from "uuid";
import { beforeEach, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { withAppTx } from "@/lib/db/pg";
import { connect } from "@/lib/deployment/__tests__/managedFixtures";
import {
	canonicalLookupTable,
	lookupDefinitionDigest,
} from "@/lib/deployment/hqResourceBaseline";
import {
	manageLookupTableInNova,
	refreshManagedLookupTable,
} from "@/lib/deployment/managedData";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { readInventoryPiece, readInventoryStatus } from "../generations/read";
import { reclaimLookupStorageBatch } from "../generations/recovery";
import type { InventoryAccess } from "../generations/scope";
import {
	beginInventory,
	cancelInventory,
	checkInventoryRun,
	pauseInventory,
	promoteInventory,
	stageInventoryPage,
} from "../generations/store";
import {
	createManagedLookupTablesInTransaction,
	readManagedTableReview,
} from "../managed";
import { authorizeLookupWriteInTransaction } from "../writerTransaction";

vi.mock("@/lib/commcare/encryption", () => ({
	decrypt: vi.fn(async () => "synthetic"),
}));
const h = setupAppStateTestDb("lookup_generations_", {
	authSchema: "migrated",
	poolMax: 3,
});
const scope = {
	actorId: "source-editor",
	projectId: "source-project",
	role: "editor",
};
const grant = { kind: "session", sessionId: "inventory-session" } as const;
const domain = "clinic";
const remoteId = "a".repeat(32);
const table = {
	id: remoteId,
	tag: "districts",
	fields: ["code"],
	fieldProperties: { code: [] },
	isGlobal: true,
	itemAttributes: [],
};
const canonical = canonicalLookupTable(table, null);
const candidate = {
	domain,
	server: "india",
	remoteId,
	canonicalDefinition: lookupDefinitionDigest(table),
	definitionDigest: "b".repeat(64),
	keyDigest: canonicalJsonDigest("ciphertext"),
};

beforeEach(async () => {
	await h.seedProjectMember(scope.actorId, scope.projectId, "editor");
	await connect(h, scope.actorId, "india", [domain]);
	await sql`INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES
		(${grant.sessionId},'synthetic-session',${scope.actorId},now()+interval '1 hour',now(),now())`.execute(
		h.db(),
	);
});

async function managed(): Promise<InventoryAccess> {
	const tableId = lookupTableIdSchema.parse(v7());
	await withAppTx(async (tx) =>
		createManagedLookupTablesInTransaction(
			tx,
			await authorizeLookupWriteInTransaction(tx, scope, "edit"),
			[
				{
					binding: {
						tableId,
						tag: table.tag,
						columns: { code: lookupColumnIdSchema.parse(v7()) },
					},
					name: "Districts",
					content: { fields: ["code"], rows: [] },
					origin: {
						server: "india",
						domain,
						remoteId,
						canonical: { ...canonical },
					},
				},
			],
			new Date(),
		),
	);
	return { scope, grant, tableId };
}
async function used() {
	const result = await sql<{
		used_bytes: string;
	}>`SELECT used_bytes FROM lookup_storage_budgets WHERE project_id=${scope.projectId}`.execute(
		h.db(),
	);
	return Number(result.rows[0].used_bytes);
}
const row = {
	sourceId: "c".repeat(32),
	attributes: {},
	fields: { code: [{ value: "first", properties: {} }] },
};
const page = {
	start: 0,
	offset: 1,
	throughDigest: "d".repeat(64),
	rows: [row],
};
const witness = {
	throughDigest: page.throughDigest,
	definitionDigest: candidate.definitionDigest,
	offset: 1,
	totalCount: 1,
};

it("publishes only a bracketed stable inventory through Project refresh, retains exact lexical content across ranges, and stops ranges on grant expiry", async () => {
	const access = await managed();
	const raw = {
		id: remoteId,
		tag: table.tag,
		is_global: true,
		item_attributes: [],
		fields: [{ field_name: "code", properties: [] }],
	};
	const value = '🌱"'.repeat(19000);
	const scopePath = "/a/clinic/api";
	await withHttpPeer(async (peer) => {
		const host = peer.get("https://india.commcarehq.org");
		const reply = (path: string, body: object, times: number) =>
			host
				.intercept({
					path,
					method: "GET",
					headers: { authorization: "ApiKey account:synthetic" },
				})
				.reply(200, body)
				.times(times);
		reply(
			`${scopePath}/lookup_table/v1/?limit=1000`,
			{ meta: { offset: 0, total_count: 1, next: null }, objects: [raw] },
			1,
		);
		reply(`${scopePath}/lookup_table/v1/${remoteId}/`, raw, 2);
		reply(
			`${scopePath}/fixture/v1/?fixture_type_id=${remoteId}`,
			{
				meta: { offset: 0, total_count: 1, next: null },
				objects: [
					{
						id: row.sourceId,
						fixture_type: table.tag,
						fields: { code: value },
					},
				],
			},
			2,
		);
		expect(
			await refreshManagedLookupTable(scope, access.tableId, grant),
		).toMatchObject({
			ok: true,
			receipt: { changed: "definition" },
			table: {
				rowCount: null,
				dataBytes: null,
				hq: { source: { storage: "generation", inventory: "complete" } },
			},
		});
	});
	const status = await readInventoryStatus(access);
	expect(status.active?.totalRows).toBe(1);
	let piece = await readInventoryPiece(access);
	if (!piece.next || !piece.item)
		throw new Error("Expected a split source row.");
	const firstCursor = piece.next;
	let text = piece.item.part;
	while (piece.next) {
		piece = await readInventoryPiece(access, piece.next);
		if (!piece.item) throw new Error("Expected the rest of the row.");
		expect(piece.item.byteLength).toBeLessThanOrEqual(32768);
		text += piece.item.part;
	}
	expect(JSON.parse(text)).toEqual({
		sourceId: row.sourceId,
		attributes: {},
		fields: { code: [{ value, properties: {} }] },
	});
	await sql`UPDATE auth_session SET "expiresAt"=now() WHERE id=${grant.sessionId}`.execute(
		h.db(),
	);
	await expect(readInventoryPiece(access, firstCursor)).rejects.toMatchObject({
		code: "not_found",
	});
});

it("deduplicates only byte-identical contiguous pages, fences abandoned writers, and never spends a retired generation before deletion", async () => {
	const access = await managed();
	const before = await used();
	const { run } = await beginInventory(access, candidate);
	await stageInventoryPage(run, page);
	const staged = await used();
	await stageInventoryPage(run, page);
	expect(await used()).toBe(staged);
	await expect(
		stageInventoryPage(run, { ...page, rows: [{ ...row, fields: {} }] }),
	).rejects.toMatchObject({ code: "conflict" });
	await expect(
		stageInventoryPage(run, { ...page, start: 2, offset: 3 }),
	).rejects.toMatchObject({ code: "conflict" });
	await expect(
		stageInventoryPage(run, { ...page, start: 1, offset: 2 }),
	).rejects.toMatchObject({ code: "conflict" });
	expect((await readInventoryStatus(access)).active).toBeNull();
	await pauseInventory(run);
	const resumed = await beginInventory(access, candidate);
	expect(resumed.run.id).toBe(run.id);
	expect(resumed.checkpoint).toEqual({
		offset: 1,
		throughDigest: page.throughDigest,
	});
	await expect(checkInventoryRun(run)).rejects.toMatchObject({
		code: "conflict",
	});
	await expect(
		promoteInventory(
			resumed.run,
			{ ...witness, totalCount: 2 },
			{ ...canonical },
		),
	).rejects.toMatchObject({ code: "conflict" });
	await cancelInventory(access);
	await expect(
		promoteInventory(resumed.run, witness, { ...canonical }),
	).rejects.toMatchObject({ code: "conflict" });
	expect(await used()).toBeGreaterThan(before);
	while (
		await withAppTx((tx) => reclaimLookupStorageBatch(tx, scope.projectId))
	) {
		/* Each iteration commits a bounded refund. */
	}
	expect(await used()).toBe(before);
	expect(
		await withAppTx((tx) => reclaimLookupStorageBatch(tx, scope.projectId)),
	).toBe(false);
});

it("fences the original runner after lease recovery, rechecks membership, and holds the old inventory on an over-budget refresh", async () => {
	const access = await managed();
	const { run } = await beginInventory(access, candidate);
	await stageInventoryPage(run, page);
	await sql`UPDATE lookup_generations SET lease_until=now() WHERE id=${run.id}`.execute(
		h.db(),
	);
	const resumed = await beginInventory(access, candidate);
	expect(resumed.run.id).toBe(run.id);
	await pauseInventory(run);
	await checkInventoryRun(resumed.run);
	await promoteInventory(resumed.run, witness, {
		...canonical,
		source: {
			...canonical.source,
			inventory: "complete",
			storage: "generation",
		},
	});
	const first = await readInventoryPiece(access);
	const refresh = await beginInventory(access, candidate);
	await sql`UPDATE lookup_storage_budgets SET capacity_bytes=used_bytes+3000 WHERE project_id=${scope.projectId}`.execute(
		h.db(),
	);
	await expect(
		stageInventoryPage(refresh.run, {
			...page,
			rows: [
				{
					...row,
					fields: { code: [{ value: "x".repeat(10_000), properties: {} }] },
				},
			],
		}),
	).rejects.toMatchObject({ code: "storage_limit" });
	expect(await readInventoryPiece(access)).toEqual(first);
	await sql`UPDATE auth_member SET role='viewer' WHERE "organizationId"=${scope.projectId} AND "userId"=${scope.actorId}`.execute(
		h.db(),
	);
	await expect(readInventoryPiece(access)).rejects.toMatchObject({
		code: "not_found",
	});
	await expect(stageInventoryPage(refresh.run, page)).rejects.toMatchObject({
		code: "not_found",
	});
	await sql`UPDATE auth_member SET role='editor' WHERE "organizationId"=${scope.projectId} AND "userId"=${scope.actorId}`.execute(
		h.db(),
	);
	await expect(checkInventoryRun(refresh.run)).rejects.toMatchObject({
		code: "conflict",
	});
});

it("reconciles a changed definition at promotion, holds its stable identities and transfers exact large leaves only after a full current global restore", async () => {
	await sql`UPDATE auth_member SET role='admin' WHERE "userId"=${scope.actorId} AND "organizationId"=${scope.projectId}`.execute(
		h.db(),
	);
	const access = await managed();
	const admin = { ...scope, role: "admin" };
	const codeId = (await readManagedTableReview(scope.projectId, access.tableId))
		?.definition.columns[0].id;
	const raw = {
		id: remoteId,
		tag: table.tag,
		is_global: true,
		item_attributes: [],
		fields: [
			{ field_name: "code", properties: [] },
			{ field_name: "name", properties: ["lang"] },
		],
	};
	const value = "🌱".repeat(17000) + "007 ";
	const api = "/a/clinic/api";
	const source = await withHttpPeer(async (peer) => {
		const host = peer.get("https://india.commcarehq.org");
		const serve = (path: string, body: object | string) =>
			host
				.intercept({
					path,
					method: "GET",
					headers: { authorization: "ApiKey account:synthetic" },
				})
				.reply(200, body)
				.persist();
		serve(api + "/lookup_table/v1/?limit=1000", {
			meta: { offset: 0, total_count: 1, next: null },
			objects: [raw],
		});
		serve(api + "/lookup_table/v1/" + remoteId + "/", raw);
		serve(api + "/fixture/v1/?fixture_type_id=" + remoteId, {
			meta: { offset: 0, total_count: 1, next: null },
			objects: [
				{
					id: row.sourceId,
					fixture_type: table.tag,
					fields: { code: "007", name: value },
				},
			],
		});
		serve(api + "/lookup_table_item/v1/" + row.sourceId + "/", {
			id: row.sourceId,
			data_type_id: remoteId,
			sort_key: 71,
			item_attributes: {},
			fields: {
				code: { field_list: [{ field_value: "007", properties: {} }] },
				name: {
					field_list: [{ field_value: value, properties: { lang: "sw" } }],
				},
			},
		});
		const refreshed = await refreshManagedLookupTable(
			admin,
			access.tableId,
			grant,
		);
		expect(refreshed).toMatchObject({
			ok: true,
			receipt: { changed: "definition", addedColumns: [{ wireName: "name" }] },
		});
		const review = await readManagedTableReview(
			scope.projectId,
			access.tableId,
		);
		if (!review) throw Error("Missing management review");
		expect(review.definition.columns[0].id).toBe(codeId);
		const column = review.definition.columns[1];
		expect(column).toMatchObject({
			wireName: "name",
			repeated: true,
			properties: [{ wireName: "lang" }],
		});
		const status = await readInventoryStatus(access);
		expect(status.active?.totalRows).toBe(1);
		const fixture = (
			text: string,
		) => `<OpenRosaResponse xmlns="http://openrosa.org/http/response"><message nature="ota_restore_success">OK</message>
            <Sync xmlns="http://commcarehq.org/sync"><restore_id>token</restore_id></Sync>
            <Registration xmlns="http://openrosa.org/user/registration"><username>account</username><uuid>u1</uuid><user_data><data key="commcare_user_type">web</data><data key="commcare_project">clinic</data></user_data></Registration>
            <schema id="item-list:districts"><indices><index>name</index></indices></schema><fixture indexed="true" user_id="u1" id="item-list:districts"><districts_list>
            <districts><code>007</code><name lang="sw">${text}</name></districts></districts_list></fixture></OpenRosaResponse>`;
		const restore = "/a/clinic/phone/restore/?overwrite_cache=true";
		host
			.intercept({ path: restore, method: "GET" })
			.reply(200, fixture(value + "stale"));
		const stale = await manageLookupTableInNova(
			admin,
			access.tableId,
			review.reviewDigest,
			grant,
		);
		expect(stale).toMatchObject({ ok: false, reason: "unsupported" });
		expect((await readInventoryStatus(access)).active?.generationId).toBe(
			status.active?.generationId,
		);
		expect(
			await h
				.db()
				.selectFrom("lookup_rows")
				.select("id")
				.where("table_id", "=", access.tableId)
				.execute(),
		).toEqual([]);
		host
			.intercept({ path: restore, method: "GET" })
			.reply(200, fixture(value))
			.times(2);
		expect(
			await manageLookupTableInNova(
				admin,
				access.tableId,
				review.reviewDigest,
				grant,
			),
		).toMatchObject({ ok: true, table: { hq: { managedBy: "nova" } } });
		return column;
	});
	const rowStored = await h
		.db()
		.selectFrom("lookup_rows")
		.select([
			"id",
			"hq_row_id",
			"hq_sort_key",
			"values",
			"content",
			"external_bytes",
		])
		.where("table_id", "=", access.tableId)
		.executeTakeFirstOrThrow();
	expect(rowStored).toMatchObject({
		hq_row_id: row.sourceId,
		hq_sort_key: 71,
		values: { [String(codeId)]: "007" },
		content: {
			occurrences: {
				[source.id]: [
					{
						text: "",
						properties: { [String(source.properties?.[0].id)]: "sw" },
					},
				],
			},
		},
	});
	expect(Number(rowStored.external_bytes)).toBe(Buffer.byteLength(value));
	const stored = await sql<{
		text: string;
		digest: string;
		slot: string[];
	}>`SELECT string_agg(convert_from(b.body,'UTF8'),'' ORDER BY s.byte_offset) AS text,r.digest,r.slot
        FROM lookup_cell_value_refs r JOIN lookup_cell_segments s USING(project_id,value_id) JOIN lookup_cell_blobs b ON b.project_id=s.project_id AND b.id=s.blob_id
        WHERE r.project_id=${scope.projectId} AND r.table_id=${access.tableId} GROUP BY r.digest,r.slot`.execute(
		h.db(),
	);
	expect(stored.rows).toEqual([
		{
			text: value,
			digest: expect.any(String),
			slot: ["occurrence", source.id, "0"],
		},
	]);
});
