/**
 * The lookup-table and place comparisons over CommCare HQ's own answers,
 * retained by the lane under `proof/hq-reads/lookups/` and
 * `proof/hq-reads/places/`. Each answer
 * reaches the comparison through the production reader, served by a peer,
 * so the shapes compared are the ones HQ serves.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { type HqLocation, listHqLocations } from "@/lib/commcare/hq/locations";
import {
	type HqFixtureRow,
	type HqLookupTable,
	listHqLookupTables,
	readHqLookupTableRows,
} from "@/lib/commcare/hq/lookupTables";
import {
	ABSENT_RESOURCE_DIGEST,
	canonicalLookupTable,
	canonicalPlace,
	lookupDefinitionChange,
	lookupDefinitionDigest,
	lookupIdentityChange,
	lookupRowsChange,
	placeChange,
} from "../hqResourceBaseline";

const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: "india",
} as const;
const HOST = "https://india.commcarehq.org";
const DOMAIN = "clinic";
const READS = path.join(process.cwd(), "proof/hq-reads");

type RetainedAnswer =
	| {
			readonly status: number;
			readonly headers: Record<string, string>;
			readonly body: string;
	  }
	| { readonly exception: string };

function retained(relative: string): RetainedAnswer {
	return JSON.parse(readFileSync(path.join(READS, relative), "utf8"));
}

function serve(peer: MockAgent, requestPath: string, answer: RetainedAnswer) {
	const route = peer.get(HOST).intercept({ path: requestPath, method: "GET" });
	if ("exception" in answer) route.reply(500, "Internal Server Error");
	else route.reply(answer.status, answer.body, { headers: answer.headers });
}

async function tablesFrom(relative: string): Promise<readonly HqLookupTable[]> {
	return withHttpPeer(async (peer) => {
		serve(peer, "/a/clinic/api/lookup_table/v1/?limit=100", retained(relative));
		const tables = await listHqLookupTables(CREDS, DOMAIN);
		if ("success" in tables) throw new Error(`${relative} did not parse`);
		return tables;
	});
}

function tagged(tables: readonly HqLookupTable[], tag: string): HqLookupTable {
	const table = tables.find((candidate) => candidate.tag === tag);
	if (table === undefined) throw new Error(`no table ${tag}`);
	return table;
}

/** One table's rows, following HQ's cursor over the retained pages. */
async function rowsFrom(
	tableId: string,
	pages: readonly string[],
): Promise<{ totalCount: number; rows: readonly HqFixtureRow[] }> {
	return withHttpPeer(async (peer) => {
		let next = `/a/clinic/api/fixture/v1/?fixture_type_id=${tableId}`;
		for (const page of pages) {
			const answer = retained(page);
			serve(peer, next, answer);
			if ("exception" in answer) break;
			const cursor = (
				JSON.parse(answer.body) as { meta: { next: string | null } }
			).meta.next;
			if (cursor === null) break;
			const url = new URL(cursor, `${HOST}${next}`);
			next = `${url.pathname}${url.search}`;
		}
		const rows = await readHqLookupTableRows(CREDS, DOMAIN, tableId);
		if ("success" in rows)
			throw new Error(`the rows of ${tableId} did not read`);
		return rows;
	});
}

async function placesFrom(relative: string): Promise<readonly HqLocation[]> {
	return withHttpPeer(async (peer) => {
		serve(peer, "/a/clinic/api/location/v2/?limit=1000", retained(relative));
		const places = await listHqLocations(CREDS, DOMAIN);
		if ("success" in places) throw new Error(`${relative} did not parse`);
		return places;
	});
}

describe("a lookup table", () => {
	it("compares in order: where the table is, then its definition, then its rows", async () => {
		const tables = await tablesFrom("lookups/lookup-tables.json");
		const plain = tagged(tables, "plain");
		const rows = await rowsFrom(plain.id, ["lookups/fixture-rows-plain.json"]);
		const baseline = canonicalLookupTable(plain, rows.rows);

		expect(
			lookupIdentityChange({ mappedRemoteId: plain.id, tag: "plain", tables }),
		).toBeNull();
		expect(lookupDefinitionChange(baseline, plain)).toEqual([]);
		expect(lookupRowsChange(baseline, rows)).toEqual([]);

		/* HQ's table editor added a column: the definition read shows it, and
		 * the rows read that would fail is never needed. */
		const widened = tagged(
			await tablesFrom("lookups/lookup-tables-after-column-added.json"),
			"plain",
		);
		expect(widened.id).toBe(plain.id);
		expect(lookupDefinitionChange(baseline, widened)).toEqual([
			{ kind: "definition" },
		]);
		expect(lookupDefinitionDigest(widened)).not.toBe(baseline.definitionDigest);

		const renamed = await tablesFrom("lookups/lookup-tables-after-rename.json");
		expect(
			lookupIdentityChange({
				mappedRemoteId: plain.id,
				tag: "plain",
				tables: renamed,
			}),
		).toEqual({ kind: "renamed", tag: "plain_renamed" });
		expect(
			lookupIdentityChange({
				mappedRemoteId: plain.id,
				tag: "plain",
				tables: tables.filter((table) => table.id !== plain.id),
			}),
		).toEqual({ kind: "deleted" });
	});

	it("digests both row shapes, leaves row ids out, and reads the count before the digest", async () => {
		const tables = await tablesFrom("lookups/lookup-tables.json");
		const rich = tagged(tables, "rich");
		const rows = await rowsFrom(rich.id, ["lookups/fixture-rows-rich.json"]);
		const baseline = canonicalLookupTable(rich, rows.rows);

		const renumbered = rows.rows.map((row, index) => ({
			...row,
			id: `another-${index}`,
		}));
		expect(canonicalLookupTable(rich, renumbered).rowsDigest).toBe(
			baseline.rowsDigest,
		);

		/* The multi-valued row: its properties are sorted, its values are not. */
		const listedIndex = rows.rows.findIndex((row) =>
			Object.values(row.fields).some(
				(value) => typeof value !== "string" && value.length > 1,
			),
		);
		const listed = rows.rows[listedIndex];
		if (listed === undefined) throw new Error("rich holds a multi-valued row");
		const reversedProperties = Object.fromEntries(
			Object.entries(listed.fields).map(([name, value]) => [
				name,
				typeof value === "string"
					? value
					: value.map((item) => ({
							value: item.value,
							properties: Object.fromEntries(
								Object.entries(item.properties).reverse(),
							),
						})),
			]),
		);
		const reordered = Object.fromEntries(
			Object.entries(listed.fields).map(([name, value]) => [
				name,
				typeof value === "string" ? value : [...value].reverse(),
			]),
		);
		const withRow = (fields: HqFixtureRow["fields"]) =>
			rows.rows.map((row, index) =>
				index === listedIndex ? { ...row, fields } : row,
			);
		expect(
			lookupRowsChange(baseline, {
				totalCount: rows.totalCount,
				rows: withRow(reversedProperties),
			}),
		).toEqual([]);
		expect(
			lookupRowsChange(baseline, {
				totalCount: rows.totalCount,
				rows: withRow(reordered),
			}),
		).toEqual([{ kind: "rows" }]);
		expect(
			lookupRowsChange(baseline, {
				totalCount: rows.totalCount + 1,
				rows: rows.rows,
			}),
		).toEqual([{ kind: "rows" }]);
	});

	it("digests the two pages of a 1,005-row table as one list", async () => {
		const long = tagged(await tablesFrom("lookups/lookup-tables.json"), "long");
		const rows = await rowsFrom(long.id, [
			"lookups/fixture-rows-long-1.json",
			"lookups/fixture-rows-long-2.json",
		]);
		const baseline = canonicalLookupTable(long, rows.rows);
		expect(baseline.rowCount).toBe(1005);
		expect(lookupRowsChange(baseline, rows)).toEqual([]);
		expect(
			lookupRowsChange(baseline, {
				totalCount: rows.totalCount,
				rows: [...rows.rows.slice(1000), ...rows.rows.slice(0, 1000)],
			}),
		).toEqual([{ kind: "rows" }]);
	});

	it("confirms an absence by its own digest", () => {
		expect(ABSENT_RESOURCE_DIGEST).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("a place", () => {
	function childOf(places: readonly HqLocation[]): HqLocation {
		const child = places.find((place) => place.parentLocationId !== null);
		if (child === undefined) throw new Error("the inventory holds a child");
		return child;
	}

	it("reads an update that sent a place its own values as no change, though the order moved", async () => {
		const before = await placesFrom("places/locations.json");
		const after = await placesFrom(
			"places/locations-after-unchanged-update.json",
		);
		expect(after.map((place) => place.locationId)).not.toEqual(
			before.map((place) => place.locationId),
		);
		for (const place of before) {
			const ownedKeys = Object.keys(place.values);
			const now = after.find(
				(current) => current.locationId === place.locationId,
			);
			expect(
				placeChange(canonicalPlace(place, ownedKeys), now ?? null),
			).toEqual([]);
		}
	});

	it("keeps coordinates as HQ's strings, and projects information onto the baseline's keys", async () => {
		const [parent] = (await placesFrom("places/locations.json")).filter(
			(place) => place.parentLocationId === null,
		);
		if (parent === undefined) throw new Error("the inventory holds a parent");
		const baseline = canonicalPlace(parent, []);
		expect(baseline.latitude).toBe(parent.latitude);
		expect(
			placeChange(baseline, {
				...parent,
				values: { ...parent.values, unmodeled: "set in HQ" },
			}),
		).toEqual([]);
		const owned = canonicalPlace(parent, ["modeled"]);
		expect(
			placeChange(owned, {
				...parent,
				values: { ...parent.values, modeled: "x" },
			}),
		).toEqual([{ kind: "information" }]);
		expect(
			placeChange(baseline, { ...parent, latitude: "0.0000000000" }),
		).toEqual([{ kind: "coordinates" }]);
	});

	it("reads an archived place and a deleted one each as missing", async () => {
		const child = childOf(await placesFrom("places/locations.json"));
		const baseline = canonicalPlace(child, []);
		for (const read of [
			"places/locations-after-archive.json",
			"places/locations-after-delete.json",
		]) {
			const places = await placesFrom(read);
			const current =
				places.find((place) => place.locationId === child.locationId) ?? null;
			expect(placeChange(baseline, current)).toEqual([{ kind: "missing" }]);
		}
	});
});
