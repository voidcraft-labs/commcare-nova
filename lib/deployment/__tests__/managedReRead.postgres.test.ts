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
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { getLookupTable } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";
import {
	isAccountRefusal,
	type ManagedTablesReRead,
	reReadManagedTablesForPublish,
} from "../managedData";
import {
	connect,
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

function reRead(copies: readonly ManagedCopy[]) {
	return reReadManagedTablesForPublish({
		requireHqImport: null,
		access: ACCESS,
		doc: readerOf(copies),
		target: TARGET,
		creds: CREDS,
	});
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
			"a cell over a cap",
			(table) => ({
				...table,
				rows: [{ code: "001", name: "n".repeat(70_000) }],
			}),
			{
				kind: "over-cap",
				phrase: expect.stringContaining("Nova takes 64 KB in one cell"),
			},
		],
		[
			"a field name outside the grammar",
			(table) => ({
				...table,
				fields: [...table.fields, "zone.name"],
			}),
			{ kind: "name", name: "zone.name" },
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
