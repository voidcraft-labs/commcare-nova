import { sql } from "kysely";
import { installationCredential } from "@/__tests__/helpers/installationCredential";
import { pendingInstallationTarget } from "@/__tests__/helpers/pendingInstallationTarget";
import { credentialWriteGrant } from "@/lib/mcp/credentialWriteGrant";
import { publishAppToHq } from "../service";
import { reloadHeadFor } from "./publishFixtures";
/**
 * The re-read a publish makes of the lookup tables CommCare HQ manages for
 * the app, over real Postgres and a peer standing in for CommCare HQ: each
 * change that stops it, what it refreshes, and the tables of another
 * project space it pushes from Nova's copy as it is.
 *
 * Postgres is the boundary because the contract is the copy's: what the
 * copy stores decides what changed, its caps are Postgres's own measure,
 * and "nothing refreshed" is a statement about the rows it holds.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { decrypt } from "@/lib/commcare/encryption";
import { toHqFixtureRow } from "@/lib/commcare/hq/lookupTables";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { getLookupTable } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";
import {
	canonicalLookupObservation,
	canonicalLookupTable,
	streamingLookupRowsDigest,
} from "../hqResourceBaseline";
import {
	isAccountRefusal,
	type ManagedTablesReRead,
	reReadManagedTablesForPublish,
} from "../managedData";
import {
	connect,
	hqRowsOf,
	hqTableOf,
	type ManagedCopy,
	makeManagedCopy,
	readerOf,
	refuseRows,
	type ServedTable,
	sent,
	serveRows,
	serveTableList,
} from "./managedFixtures";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});

const h = setupAppStateTestDb("managed_reread_", { authSchema: "migrated" });
const PROJECT = "program";
const ACTOR = "publisher";
const ACCESS = {
	appId: "visits-app",
	projectId: PROJECT,
	role: "editor",
	actorUserId: ACTOR,
};
const LOOKUP: LookupScope = {
	projectId: PROJECT,
	actorId: ACTOR,
	role: "editor",
};
const TARGET = { server: "india", domain: "clinic" } as const;
const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: "india",
} as const;

const facilities: ServedTable = {
	id: "a".repeat(32),
	tag: "facilities",
	fields: ["code", "name"],
	rows: [
		{ code: "001", name: "North" },
		{ code: "002", name: "South" },
	],
};
const districts: ServedTable = {
	id: "hq-districts",
	tag: "districts",
	fields: ["code", "name"],
	rows: [{ code: "d1", name: "Hill" }],
};

async function seed(): Promise<void> {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await connect(h, ACTOR, "india", ["clinic", "district"]);
}

function reRead(
	copies: readonly ManagedCopy[],
	checkAccess?: () => Promise<void>,
) {
	return reReadManagedTablesForPublish({
		requireHqImport: null,
		access: ACCESS,
		doc: readerOf(copies),
		target: TARGET,
		creds: CREDS,
		...(checkAccess === undefined ? {} : { checkAccess }),
	});
}

/** More rows than one inline read takes, so only a paged read compares them. */
const PAGED_ROWS = 5_001;
const PAGE = 1_000;

/** `facilities`' rows past one inline read, as `FixtureResource` lists them, `changed` naming one row's name differently. */
function pagedRows(changed?: number) {
	return Array.from({ length: PAGED_ROWS }, (_, index) => ({
		id: index.toString(16).padStart(32, "0"),
		fixture_type: facilities.tag,
		fields: {
			code: String(index),
			name: index === changed ? "Moved" : `Clinic ${index}`,
		},
	}));
}

/**
 * Serve `objects` in pages of `PAGE`, and the table's definition, as CommCare
 * HQ answers a paged read of a table; each fixture page read is counted.
 */
function servePaged(
	peer: Parameters<Parameters<typeof withHttpPeer>[0]>[0],
	objects: readonly object[],
): { readonly pages: () => number } {
	const host = peer.get("https://india.commcarehq.org");
	const headers = { authorization: "ApiKey account:fixture-key" };
	host
		.intercept({
			path: `/a/clinic/api/lookup_table/v1/${facilities.id}/`,
			method: "GET",
			headers,
		})
		.reply(200, {
			id: facilities.id,
			tag: facilities.tag,
			is_global: true,
			fields: facilities.fields.map((field) => ({
				field_name: field,
				properties: [],
			})),
		})
		.persist();
	let pages = 0;
	for (let offset = 0; offset < objects.length; offset += PAGE) {
		const end = Math.min(offset + PAGE, objects.length);
		host
			.intercept({
				path: `/a/clinic/api/fixture/v1/?fixture_type_id=${facilities.id}${offset === 0 ? "" : `&offset=${offset}`}`,
				method: "GET",
				headers,
			})
			.reply(() => {
				pages += 1;
				return {
					statusCode: 200,
					data: JSON.stringify({
						meta: {
							offset,
							total_count: objects.length,
							next: end < objects.length ? "more" : null,
						},
						objects: objects.slice(offset, end),
					}),
				};
			})
			.persist();
	}
	return { pages: () => pages };
}

/**
 * Store as the copy's digest what a paged refresh stores for `objects`
 * (`managedInventory.ts`: `canonicalLookupObservation` over the streamed rows).
 */
async function storePagedDigest(
	copy: ManagedCopy,
	objects: readonly unknown[],
) {
	const rows = streamingLookupRowsDigest();
	for (const raw of objects) {
		const row = toHqFixtureRow(raw, facilities.tag);
		if (row === null) throw new Error("A served row must read as a row.");
		rows.row(row);
	}
	const { count, digest } = rows.finish();
	const stored = await h
		.db()
		.selectFrom("lookup_tables")
		.select("hq_canonical")
		.where("id", "=", copy.tableId)
		.executeTakeFirstOrThrow();
	await h
		.db()
		.updateTable("lookup_tables")
		.set({
			hq_canonical: JSON.stringify({
				...(stored.hq_canonical as object),
				digest: canonicalLookupObservation(hqTableOf(facilities), count, digest)
					.digest,
			}),
		})
		.where("id", "=", copy.tableId)
		.execute();
}

function readOf(
	result: Awaited<ReturnType<typeof reReadManagedTablesForPublish>>,
): ManagedTablesReRead {
	if ("unreadable" in result) throw new Error("Expected the tables read");
	return result;
}

async function rowsOf(copy: ManagedCopy) {
	const table = await getLookupTable(LOOKUP, copy.tableId);
	return {
		revisions: [table.definitionRevision, table.rowsRevision],
		rows: table.rows.map((row) => row.values),
	};
}

describe("a table managed in the target", () => {
	it("refreshes nothing where CommCare HQ's table is as the copy holds it, and hands the list on", async () => {
		await seed();
		const copy = await makeManagedCopy(h, LOOKUP, facilities, TARGET);
		const before = await rowsOf(copy);
		const result = await withHttpPeer(async (peer) => {
			serveTableList(peer, "clinic", [facilities]);
			serveRows(peer, "clinic", facilities);
			return readOf(await reRead([copy]));
		});
		expect(result).toMatchObject({ blocking: [], refreshed: [], stale: [] });
		expect(result.hqTables?.map((table) => table.tag)).toEqual(["facilities"]);
		expect(await rowsOf(copy)).toEqual(before);
	});

	it("refreshes the copy where only rows changed, with the publisher as who refreshed it", async () => {
		await seed();
		const copy = await makeManagedCopy(h, LOOKUP, facilities, TARGET);
		const changed = {
			...facilities,
			rows: [...facilities.rows, { code: "003", name: "East" }],
		};
		const result = await withHttpPeer(async (peer) => {
			serveTableList(peer, "clinic", [changed]);
			serveRows(peer, "clinic", changed);
			return readOf(await reRead([copy]));
		});
		expect(result.blocking).toEqual([]);
		expect(result.refreshed).toMatchObject([
			{ tag: "facilities", receipt: { changed: "rows" } },
		]);
		const table = await getLookupTable(LOOKUP, copy.tableId);
		expect(table.rows).toHaveLength(3);
		const stored = await h
			.db()
			.selectFrom("lookup_tables")
			.select("hq_refreshed_by")
			.where("id", "=", copy.tableId)
			.executeTakeFirstOrThrow();
		expect(stored.hq_refreshed_by).toBe(ACTOR);
	});

	it.each(["field property", "assigned rows", "repeated values"] as const)(
		"refreshes %s from just the source-managed table",
		async (shape) => {
			await seed();
			const copy = await makeManagedCopy(h, LOOKUP, facilities, TARGET);
			const latest: ServedTable =
				shape === "field property"
					? { ...facilities, fieldProperties: { name: ["lang"] } }
					: shape === "assigned rows"
						? { ...facilities, isGlobal: false }
						: { ...facilities, manyValues: { name: ["North", "Nord"] } };
			const result = await withHttpPeer(async (peer) => {
				serveTableList(peer, "clinic", [latest]);
				serveRows(peer, "clinic", latest);
				return readOf(await reRead([copy]));
			});
			expect(result.blocking).toEqual([]);
			const stored = await h
				.db()
				.selectFrom("lookup_tables")
				.select("hq_canonical")
				.where("id", "=", copy.tableId)
				.executeTakeFirstOrThrow();
			expect(stored.hq_canonical?.source).toMatchObject({
				distribution: shape === "assigned rows" ? "assigned" : "global",
			});
		},
	);
	it("checks a newly pending destination before publishing a managed table refresh", async () => {
		await seed();
		const copy = await makeManagedCopy(h, LOOKUP, facilities, TARGET);
		const doc = readerOf([copy]);
		await h.seedAppWithBlueprint(doc, {
			id: ACCESS.appId,
			projectId: PROJECT,
			owner: ACTOR,
		});
		const before = await rowsOf(copy);
		const ctx = await installationCredential(h.db(), ACTOR, [
			"nova.read",
			"nova.write",
			"nova.hq.write",
			"nova.hq.import",
		]);
		const grant = credentialWriteGrant(ctx, "upload_app_to_hq", [
			"nova.hq.import",
			"nova.hq.write",
		]);
		const changed = {
			...facilities,
			rows: [...facilities.rows, { code: "003", name: "East" }],
		};
		await withHttpPeer(async (peer) => {
			serveTableList(peer, "clinic", [changed]);
			serveRows(peer, "clinic", changed, undefined, async () => {
				await pendingInstallationTarget(h, ACCESS, TARGET);
				await sql`UPDATE auth_apikey SET enabled=false WHERE "referenceId"=${ACTOR}`.execute(
					h.db(),
				);
			});
			await expect(
				publishAppToHq({
					requireHqImport: null,
					scope: { ...ACCESS, requireInstallationManagement: grant },
					...TARGET,
					doc,
					compiledAtSeq: 0,
					reloadHead: reloadHeadFor(ACCESS.appId, ACTOR),
					appName: doc.appName,
				}),
			).rejects.toMatchObject({ name: "McpCredentialInactiveError" });
		});
		expect(await rowsOf(copy)).toEqual(before);
	});
	it("holds the installation grant while refreshed managed table rows become visible", async () => {
		await seed();
		const copy = await makeManagedCopy(h, LOOKUP, facilities, TARGET);
		const prior = await getLookupTable(LOOKUP, copy.tableId);
		const ctx = await installationCredential(h.db(), ACTOR, [
			"nova.read",
			"nova.write",
			"nova.hq.import",
			"nova.hq.write",
		]);
		const grant = credentialWriteGrant(ctx, "upload_app_to_hq", [
			"nova.hq.import",
			"nova.hq.write",
		]);
		await grant();
		const changed = {
			...facilities,
			rows: [...facilities.rows, { code: "003", name: "East" }],
		};
		await withHttpPeer(async (peer) => {
			serveTableList(peer, "clinic", [changed]);
			serveRows(peer, "clinic", changed, undefined, async () => {
				await sql`UPDATE auth_apikey SET enabled=false WHERE "referenceId"=${ACTOR}`.execute(
					h.db(),
				);
			});
			await expect(
				reReadManagedTablesForPublish({
					requireHqImport: null,
					access: ACCESS,
					doc: readerOf([copy]),
					target: TARGET,
					creds: CREDS,
					grant: async (tx) => {
						expect(tx).toBeDefined();
						await grant(tx);
					},
				}),
			).rejects.toMatchObject({ name: "McpCredentialInactiveError" });
		});
		expect((await getLookupTable(LOOKUP, copy.tableId)).rows).toEqual(
			prior.rows,
		);
	});
	const stops: readonly [
		string,
		(table: ServedTable) => ServedTable | null,
		unknown,
	][] = [
		["the table gone", () => null, { kind: "table-gone" }],
		[
			"a column the app reads gone",
			(table) => ({
				...table,
				fields: ["code"],
				rows: table.rows.map(({ code }) => ({ code })),
			}),
			{ kind: "column-gone", column: "name", uses: 1 },
		],
		[
			"a cell past one inline copy that changed since the copy",
			(table) => ({
				...table,
				rows: [{ code: "001", name: "n".repeat(70_000) }],
			}),
			{ kind: "past-inline-read" },
		],
		[
			"a field name outside the grammar",
			(table) => ({
				...table,
				fields: [...table.fields, "zone name"],
			}),
			{ kind: "name", name: "zone name" },
		],
		[
			"a character XML can't carry",
			(table) => ({
				...table,
				rows: [{ code: "001", name: "North\u0001" }],
			}),
			{ kind: "unrepresentable-text", column: "name" },
		],
	];

	it.each(stops)(
		"stops on %s and leaves the copy as it was",
		async (_label, change, expected) => {
			await seed();
			const copy = await makeManagedCopy(h, LOOKUP, facilities, TARGET);
			const before = await rowsOf(copy);
			const served = change(facilities);
			const result = await withHttpPeer(async (peer) => {
				serveTableList(peer, "clinic", served === null ? [] : [served]);
				if (served !== null) serveRows(peer, "clinic", served);
				return readOf(await reRead([copy]));
			});
			expect(result.blocking).toEqual([
				{ tag: "facilities", name: "facilities", changes: [expected] },
			]);
			expect(result.refreshed).toEqual([]);
			expect(await rowsOf(copy)).toEqual(before);
		},
	);

	it("passes a table past one inline copy that is still the table Nova's copy took, and refreshes nothing", async () => {
		/* The plausible failure: a table no inline copy can carry stops every
		 * publish as if it changed, though the copy a paged refresh took is
		 * current. The stored digest is set to CommCare HQ's table as served,
		 * the state a paged refresh leaves. */
		await seed();
		const copy = await makeManagedCopy(h, LOOKUP, facilities, TARGET);
		const large: ServedTable = {
			...facilities,
			rows: [{ code: "001", name: "n".repeat(70_000) }],
		};
		const stored = await h
			.db()
			.selectFrom("lookup_tables")
			.select("hq_canonical")
			.where("id", "=", copy.tableId)
			.executeTakeFirstOrThrow();
		await h
			.db()
			.updateTable("lookup_tables")
			.set({
				hq_canonical: JSON.stringify({
					...(stored.hq_canonical as object),
					digest: canonicalLookupTable(hqTableOf(large), hqRowsOf(large))
						.digest,
				}),
			})
			.where("id", "=", copy.tableId)
			.execute();
		const before = await rowsOf(copy);
		const result = await withHttpPeer(async (peer) => {
			serveTableList(peer, "clinic", [large]);
			serveRows(peer, "clinic", large);
			return readOf(await reRead([copy]));
		});
		expect(result).toMatchObject({ blocking: [], refreshed: [], stale: [] });
		expect(await rowsOf(copy)).toEqual(before);
	});

	it("stops on a table past one inline read it cannot compare page by page, with the refresh it needs", async () => {
		await seed();
		const copy = await makeManagedCopy(h, LOOKUP, facilities, TARGET);
		const result = await withHttpPeer(async (peer) => {
			serveTableList(peer, "clinic", [facilities]);
			peer
				.get("https://india.commcarehq.org")
				.intercept({
					path: `/a/clinic/api/fixture/v1/?fixture_type_id=${facilities.id}`,
					method: "GET",
				})
				.reply(200, {
					objects: facilities.rows.map((fields, index) => ({
						id: `row-${index}`,
						fixture_type: facilities.tag,
						fields,
					})),
					meta: { next: "more", offset: 0, total_count: 5_001 },
				});
			return readOf(await reRead([copy]));
		});
		expect(result.blocking).toEqual([
			{
				tag: "facilities",
				name: "facilities",
				changes: [{ kind: "past-inline-read" }],
			},
		]);
	});

	it("passes a table past one inline read that is still the copy's table, compared page by page under the publisher's check", async () => {
		/* The plausible failure: the paged compare is never reached (the check
		 * not handed in, or the paged arm broken), or its digest differs from
		 * what a paged refresh stores, and every publish stops as if the
		 * table changed. */
		await seed();
		const copy = await makeManagedCopy(h, LOOKUP, facilities, TARGET);
		const served = pagedRows();
		await storePagedDigest(copy, served);
		const before = await rowsOf(copy);
		let checks = 0;
		const { result, pages } = await withHttpPeer(async (peer) => {
			serveTableList(peer, "clinic", [facilities]);
			const paged = servePaged(peer, served);
			const answer = readOf(
				await reRead([copy], async () => {
					checks += 1;
				}),
			);
			return { result: answer, pages: paged.pages() };
		});
		expect(result).toMatchObject({ blocking: [], refreshed: [], stale: [] });
		expect(await rowsOf(copy)).toEqual(before);
		/* One inline look at the first page, then each paged page read only
		 * after the publisher's check passed. */
		expect(checks).toBeGreaterThan(0);
		expect(checks).toBe(pages - 1);
	});

	it("stops on a table past one inline read whose rows changed since the copy took it", async () => {
		await seed();
		const copy = await makeManagedCopy(h, LOOKUP, facilities, TARGET);
		await storePagedDigest(copy, pagedRows());
		const result = await withHttpPeer(async (peer) => {
			serveTableList(peer, "clinic", [facilities]);
			servePaged(peer, pagedRows(4_321));
			return readOf(await reRead([copy], async () => {}));
		});
		expect(result.blocking).toEqual([
			{
				tag: "facilities",
				name: "facilities",
				changes: [{ kind: "past-inline-read" }],
			},
		]);
	});

	it("answers every stop of every table at once and refreshes none, a table that only changed rows included", async () => {
		await seed();
		const facilityCopy = await makeManagedCopy(h, LOOKUP, facilities, TARGET);
		const districtCopy = await makeManagedCopy(h, LOOKUP, districts, TARGET);
		const regions: ServedTable = {
			id: "hq-regions",
			tag: "regions",
			fields: ["code", "name"],
			rows: [{ code: "r1", name: "Coast" }],
		};
		const regionCopy = await makeManagedCopy(h, LOOKUP, regions, TARGET);
		const before = await rowsOf(regionCopy);
		const result = await withHttpPeer(async (peer) => {
			const shrunk = {
				...districts,
				fields: ["code"],
				rows: [{ code: "d1" }],
			};
			const grown = {
				...regions,
				rows: [...regions.rows, { code: "r2", name: "Delta" }],
			};
			serveTableList(peer, "clinic", [shrunk, grown]);
			serveRows(peer, "clinic", shrunk);
			serveRows(peer, "clinic", grown);
			return readOf(await reRead([facilityCopy, districtCopy, regionCopy]));
		});
		expect(
			result.blocking.map(({ tag, changes }) => ({ tag, changes })),
		).toEqual(
			expect.arrayContaining([
				{ tag: "facilities", changes: [{ kind: "table-gone" }] },
				{
					tag: "districts",
					changes: [{ kind: "column-gone", column: "name", uses: 1 }],
				},
			]),
		);
		expect(result.blocking).toHaveLength(2);
		expect(result.refreshed).toEqual([]);
		expect(await rowsOf(regionCopy)).toEqual(before);
	});

	it("answers a refused rows read as the account's to fix, naming the table", async () => {
		await seed();
		const copy = await makeManagedCopy(h, LOOKUP, facilities, TARGET);
		const result = await withHttpPeer(async (peer) => {
			serveTableList(peer, "clinic", [facilities]);
			refuseRows(peer, "clinic", facilities, 403);
			return reRead([copy]);
		});
		if (!("unreadable" in result)) throw new Error("Expected no read");
		expect(result.rows).toBe("facilities");
		expect(result.unreadable).toMatchObject({
			kind: "permission",
			request: "lookup-rows",
		});
		expect(isAccountRefusal(result.unreadable)).toBe(true);
	});
});

describe("a table managed in another project space", () => {
	it("pushes from the copy, never stopping, where the publisher's connection is not approved there", async () => {
		await seed();
		const copy = await makeManagedCopy(h, LOOKUP, facilities, {
			server: "india",
			domain: "elsewhere",
		});
		// No request at all: the connection does not reach that project space.
		const result = await withHttpPeer(async (peer) => {
			const answer = readOf(await reRead([copy]));
			expect(sent(peer)).toEqual([]);
			return answer;
		});
		expect(result).toEqual({
			blocking: [],
			refreshed: [],
			stale: [
				{
					tag: "facilities",
					domain: "elsewhere",
					refreshedAt: "2026-11-01T09:00:00.000Z",
				},
			],
			hqTables: null,
		});
	});

	it("pushes from the copy where the table's server is not the connection's", async () => {
		await seed();
		const copy = await makeManagedCopy(h, LOOKUP, facilities, {
			server: "eu",
			domain: "district",
		});
		const result = await withHttpPeer(async (peer) => {
			const answer = readOf(await reRead([copy]));
			expect(sent(peer)).toEqual([]);
			return answer;
		});
		expect(result.stale).toEqual([
			expect.objectContaining({ tag: "facilities", domain: "district" }),
		]);
	});

	it("refreshes a table it can read, and pushes from the copy one that stops there", async () => {
		await seed();
		const facilityCopy = await makeManagedCopy(h, LOOKUP, facilities, {
			server: "india",
			domain: "district",
		});
		const districtCopy = await makeManagedCopy(h, LOOKUP, districts, {
			server: "india",
			domain: "district",
		});
		const districtBefore = await rowsOf(districtCopy);
		const result = await withHttpPeer(async (peer) => {
			const grown = {
				...facilities,
				rows: [...facilities.rows, { code: "003", name: "East" }],
			};
			serveTableList(peer, "district", [grown]);
			serveRows(peer, "district", grown);
			return readOf(await reRead([facilityCopy, districtCopy]));
		});
		expect(result.blocking).toEqual([]);
		expect(result.refreshed).toMatchObject([
			{ tag: "facilities", receipt: { changed: "rows" } },
		]);
		expect(result.stale).toEqual([
			expect.objectContaining({ tag: "districts", domain: "district" }),
		]);
		expect(await rowsOf(districtCopy)).toEqual(districtBefore);
	});
});
