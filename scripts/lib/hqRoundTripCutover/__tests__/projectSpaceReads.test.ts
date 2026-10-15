/**
 * The baseline step's table and place reads of one project space, with the
 * real client code against a peer under the test's control: which requests
 * it sends and in what order, how a refused key moves the reads to the next
 * member, and whose key each outcome is recorded against. What HQ's own
 * answers to these reads mean is the comparison's, proven over HQ's retained
 * answers in `lib/deployment/__tests__/hqResourceBaseline.test.ts` and the
 * clients' tests.
 */

import type { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import { HqReadPacer } from "../hqRead";
import type { DecryptClock } from "../kmsDecrypt";
import { hqProjectSpaceReader } from "../writer";

const HOST = "https://www.commcarehq.org";
const DOMAIN = "field-ops";
const TABLES = `/a/${DOMAIN}/api/lookup_table/v1/`;
const ROWS = `/a/${DOMAIN}/api/fixture/v1/`;
const PLACES = `/a/${DOMAIN}/api/location/v2/`;

/** A clock whose sleeps pass at once. */
function ownedClock(start = Date.parse("2026-10-15T10:00:00.000Z")) {
	let now = start;
	const clock: DecryptClock = {
		now: () => now,
		sleep: async (milliseconds) => {
			now += milliseconds;
		},
	};
	return clock;
}

const credentialsOf = (userId: string): CommCareCredentials => ({
	username: `${userId}@example.org`,
	apiKey: `key-${userId}`,
	server: "production",
});

function page(objects: unknown[]) {
	return { meta: { next: null, total_count: objects.length }, objects };
}

const TABLE_LIST = page([
	{
		id: "mapped",
		tag: "clinics",
		is_global: true,
		fields: [{ field_name: "name", properties: [] }],
		item_attributes: [],
	},
	{
		id: "unmapped",
		tag: "other",
		is_global: true,
		fields: [{ field_name: "name", properties: [] }],
		item_attributes: [],
	},
]);

const PLACE_LIST = page([
	{
		location_id: "place-1",
		name: "District 4",
		site_code: "district-4",
		location_type_code: "district",
		parent_location_id: "",
		latitude: null,
		longitude: null,
		location_data: {},
	},
]);

function intercept(
	peer: MockAgent,
	prefix: string,
	userId: string,
	query?: string,
) {
	return peer.get(HOST).intercept({
		path: (path: string) =>
			path.startsWith(prefix) && (query === undefined || path.includes(query)),
		method: "GET",
		headers: { authorization: `ApiKey ${userId}@example.org:key-${userId}` },
	});
}

describe("one project space's table and place reads", () => {
	it("reads the table list, the rows of each mapped table it holds, and the places once, each through the credential order", async () => {
		await withHttpPeer(async (peer) => {
			// The first member's key is refused on the list; every later read
			// starts again at the first member, as each read falls back on its own.
			intercept(peer, TABLES, "member-a").reply(403, "");
			intercept(peer, TABLES, "member-b").reply(200, TABLE_LIST);
			intercept(peer, ROWS, "member-a", "fixture_type_id=mapped").reply(
				200,
				page([{ id: "row-1", fields: { name: "North" } }]),
			);
			intercept(peer, PLACES, "member-a").reply(200, PLACE_LIST);
			const clock = ownedClock();
			const reads = await hqProjectSpaceReader({
				credentialSource: async (userId) => credentialsOf(userId),
				pacer: new HqReadPacer(clock),
				clock,
			})({
				server: "production",
				domain: DOMAIN,
				credentials: ["member-a", "member-b"],
				tableIds: ["mapped", "gone"],
				places: true,
			});

			expect(reads.tables?.outcome?.kind).toBe("ok");
			expect(reads.tables?.answer?.userId).toBe("member-b");
			// A mapped table the list no longer holds sends no rows read.
			expect([...reads.rows.keys()]).toEqual(["mapped"]);
			expect(reads.rows.get("mapped")?.outcome).toEqual({
				kind: "ok",
				value: {
					totalCount: 1,
					rows: [{ id: "row-1", fields: { name: "North" } }],
				},
			});
			expect(reads.rows.get("mapped")?.answer?.userId).toBe("member-a");
			expect(reads.places?.outcome?.kind).toBe("ok");
			expect(reads.keyUses.map((use) => use.userId)).toEqual([
				"member-a",
				"member-b",
			]);
			const paths = (peer.getCallHistory()?.calls() ?? []).map(
				(call) => new URL(call.fullUrl).pathname,
			);
			expect(paths).toEqual([TABLES, TABLES, ROWS, PLACES]);
		});
	});

	it("reads nothing it was not asked for", async () => {
		await withHttpPeer(async (peer) => {
			const clock = ownedClock();
			const reads = await hqProjectSpaceReader({
				credentialSource: async (userId) => credentialsOf(userId),
				pacer: new HqReadPacer(clock),
				clock,
			})({
				server: "production",
				domain: DOMAIN,
				credentials: ["member-a"],
				tableIds: [],
				places: false,
			});
			expect(reads).toEqual({
				tables: null,
				rows: new Map(),
				places: null,
				keyUses: [],
			});
			expect(peer.getCallHistory()?.calls() ?? []).toEqual([]);
		});
	});

	it("records no answer for a read every key was refused on", async () => {
		await withHttpPeer(async (peer) => {
			intercept(peer, PLACES, "member-a").reply(401, "");
			const clock = ownedClock();
			const reads = await hqProjectSpaceReader({
				credentialSource: async (userId) => credentialsOf(userId),
				pacer: new HqReadPacer(clock),
				clock,
			})({
				server: "production",
				domain: DOMAIN,
				credentials: ["member-a"],
				tableIds: [],
				places: true,
			});
			expect(reads.places).toEqual({
				outcome: { kind: "refused", status: 401 },
				answer: null,
			});
		});
	});
});
