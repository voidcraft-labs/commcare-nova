/** The one list reader of CommCare HQ, against a controlled HTTP peer whose list can change between requests. */
import type { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	MemoryMeter,
	runInLease,
	TEXT_HEAP_PER_WIRE_BYTE,
} from "../hq/memoryMeter";
import { type HqCollectionSpec, readHqCollection } from "../hq/readCollection";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const BASE = "/a/clinic/api/fixture/v1/";
const FIRST = `${BASE}?fixture_type_id=table-1`;

type Row = { readonly id: string; readonly value: string };

function spec(overrides: Partial<HqCollectionSpec<Row>> = {}) {
	return {
		label: "lookup table rows",
		firstUrl: FIRST,
		maxPages: 10,
		maxRows: 1_000,
		maxBytes: 1024 * 1024,
		row: (raw: unknown) => raw as Row,
		identity: (row: Row) => row.id,
		...overrides,
	} satisfies HqCollectionSpec<Row>;
}

/**
 * A peer serving `states[n]` to the nth pass of a list (the last state once
 * they run out), `pageSize` rows a page, with tastypie's `meta`: `next` names a
 * URL on another table, which Nova must never ask for.
 */
function servePages(
	peer: MockAgent,
	states: readonly (readonly Row[])[],
	pageSize: number,
) {
	let pass = -1;
	peer
		.get(HOST)
		.intercept({
			path: (requested) => requested.startsWith(BASE),
			method: "GET",
		})
		.reply((request) => {
			const url = new URL(request.path, HOST);
			const offset = Number(url.searchParams.get("offset") ?? "0");
			if (offset === 0) pass += 1;
			const rows = states[Math.min(pass, states.length - 1)] ?? [];
			const objects = rows.slice(offset, offset + pageSize);
			const more = offset + objects.length < rows.length;
			return {
				statusCode: 200,
				data: JSON.stringify({
					objects,
					meta: {
						next: more
							? `?fixture_type_id=another-table&limit=${pageSize}&offset=${offset + pageSize}`
							: null,
						offset,
						total_count: rows.length,
					},
				}),
			};
		})
		.persist();
}

const asked = (peer: MockAgent) =>
	(peer.getCallHistory()?.calls() ?? []).map((call) => call.fullUrl);

const rowsOf = (...ids: string[]): Row[] =>
	ids.map((id) => ({ id, value: `value of ${id}` }));

describe("readHqCollection", () => {
	it("reads a one-page list with exactly one request", async () => {
		await withHttpPeer(async (peer) => {
			servePages(peer, [rowsOf("a", "b")], 10);
			expect(await readHqCollection(CREDS, spec())).toEqual({
				rows: rowsOf("a", "b"),
				totalCount: 2,
				bytes: expect.any(Number),
			});
			expect(asked(peer)).toEqual([HOST + FIRST]);
		});
	});

	it("asks every later page by its own offset on its own selector, never the URL CommCare HQ names", async () => {
		await withHttpPeer(async (peer) => {
			servePages(peer, [rowsOf("a", "b", "c")], 2);
			const read = await readHqCollection(CREDS, spec());
			expect(read).toMatchObject({ rows: rowsOf("a", "b", "c") });
			expect(asked(peer)).toEqual([
				HOST + FIRST,
				`${HOST + FIRST}&offset=2`,
				HOST + FIRST,
				`${HOST + FIRST}&offset=2`,
			]);
		});
	});

	it("takes the rows a third pass agrees on where a delete and an insert kept the count between the first two", async () => {
		await withHttpPeer(async (peer) => {
			/* Between the first pass and the second, `b` is deleted and `d`
			 * inserted: the count holds, the set does not. */
			servePages(peer, [rowsOf("a", "b", "c"), rowsOf("a", "c", "d")], 2);
			const lease = new MemoryMeter({ heap: 64 * 1024, external: 0 }).open();
			try {
				const result = await runInLease(lease, () =>
					readHqCollection(CREDS, spec()),
				);
				expect(result).toMatchObject({ rows: rowsOf("a", "c", "d") });
				expect(
					"bytes" in result && result.bytes * TEXT_HEAP_PER_WIRE_BYTE,
				).toBe(lease.held().heap);
			} finally {
				lease.end();
			}
			expect(asked(peer)).toHaveLength(6);
		});
	});

	it("answers moved, with no rows, for a list that changes on every pass", async () => {
		await withHttpPeer(async (peer) => {
			servePages(
				peer,
				[rowsOf("a", "b", "c"), rowsOf("a", "c", "d"), rowsOf("a", "d", "e")],
				2,
			);
			expect(await readHqCollection(CREDS, spec())).toEqual({
				success: false,
				status: 503,
				cause: "moved",
			});
		});
	});

	it("answers moved for a page that names another total, and for an identity a later page repeats", async () => {
		await withHttpPeer(async (peer) => {
			const page = (
				objects: readonly Row[],
				offset: number,
				total: number,
				next: string | null,
			) => ({ objects, meta: { next, offset, total_count: total } });
			peer
				.get(HOST)
				.intercept({ path: FIRST, method: "GET" })
				.reply(200, page(rowsOf("a", "b"), 0, 3, "more"))
				.times(2);
			peer
				.get(HOST)
				.intercept({ path: `${FIRST}&offset=2`, method: "GET" })
				.reply(200, page(rowsOf("c", "d"), 2, 4, null));
			expect(await readHqCollection(CREDS, spec())).toEqual({
				success: false,
				status: 503,
				cause: "moved",
			});
			peer
				.get(HOST)
				.intercept({ path: `${FIRST}&offset=2`, method: "GET" })
				.reply(200, page(rowsOf("b"), 2, 3, null));
			expect(await readHqCollection(CREDS, spec())).toEqual({
				success: false,
				status: 503,
				cause: "moved",
			});
		});
	});

	it("refuses as malformed a page that is not at the offset asked", async () => {
		await withHttpPeer(async (peer) => {
			peer
				.get(HOST)
				.intercept({ path: FIRST, method: "GET" })
				.reply(200, {
					objects: rowsOf("a"),
					meta: { next: "more", offset: 0, total_count: 2 },
				});
			peer
				.get(HOST)
				.intercept({ path: `${FIRST}&offset=1`, method: "GET" })
				.reply(200, {
					objects: rowsOf("b"),
					meta: { next: null, offset: 0, total_count: 2 },
				});
			expect(await readHqCollection(CREDS, spec())).toEqual({
				success: false,
				status: 502,
				cause: "malformed",
			});
		});
	});

	it("answers past-limit by rows after one request, holding no row, where the first page's total is over the limit", async () => {
		await withHttpPeer(async (peer) => {
			servePages(peer, [rowsOf("a", "b", "c")], 1);
			expect(await readHqCollection(CREDS, spec({ maxRows: 2 }))).toEqual({
				kind: "past-limit",
				by: "rows",
				totalCount: 3,
			});
			expect(asked(peer)).toEqual([HOST + FIRST]);
		});
	});

	it("answers past-limit by bytes, and asks no further page, where the pages pass the byte bound", async () => {
		await withHttpPeer(async (peer) => {
			servePages(peer, [rowsOf("a", "b", "c", "d")], 1);
			/* One page is about 130 bytes: the bound admits two, and the third
			 * passes what remains. */
			expect(await readHqCollection(CREDS, spec({ maxBytes: 300 }))).toEqual({
				kind: "past-limit",
				by: "bytes",
				totalCount: 4,
			});
			expect(asked(peer)).toHaveLength(3);
		});
	});
});
