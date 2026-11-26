import assert from "node:assert/strict";
import type { MockAgent } from "undici";
import { expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type LookupSourcePage,
	readSelectedHqLookupRows,
	streamHqLookupTable,
} from "../hq/lookupSource";
import { toHqLookupTable } from "../hq/lookupTables";

const creds = { username: "editor", apiKey: "key", server: "india" } as const;
const root = "/a/sample/api";
const id = "1".repeat(32);
const first = "2".repeat(32);
const second = "3".repeat(32);
const definition = {
	id,
	tag: "clinics",
	is_global: true,
	item_attributes: ["region"],
	fields: [{ field_name: "name", properties: ["lang"] }],
};
const table = toHqLookupTable(definition);
assert(table);
const limits = { maxBytes: 10_000, maxRequests: 18, deadlineMs: 10_000 };
const list = `${root}/fixture/v1/?fixture_type_id=${id}`;
const pathOf = (row: string) => `${root}/lookup_table_item/v1/${row}/`;
const fields = (text: string, lang: string) => ({
	name: { field_list: [{ field_value: text, properties: { lang } }] },
});
const rowOf = (row: string, sort: number, lang = "en", tableId = id) => ({
	id: row,
	data_type_id: tableId,
	sort_key: sort,
	item_attributes: { region: "north" },
	fields: fields("A", lang),
});
function reply(peer: MockAgent, path: string, data: object, times = 1) {
	peer
		.get("https://india.commcarehq.org")
		.intercept({
			path,
			method: "GET",
			headers: { authorization: "ApiKey editor:key" },
		})
		.reply(200, data)
		.times(times);
}
const page = {
	meta: { offset: 0, total_count: 2, next: null },
	objects: [first, second].map((id) => ({
		id,
		fixture_type: table.tag,
		fields: { name: "A" },
	})),
};

it("brackets rich details with their definition and the exact selected table rows, including duplicate-looking singleton cells", async () => {
	await withHttpPeer(async (peer) => {
		reply(peer, `${root}/lookup_table/v1/${id}/`, definition, 2);
		reply(peer, list, page, 3);
		reply(peer, pathOf(first), rowOf(first, 5), 2);
		reply(peer, pathOf(second), rowOf(second, 5, "fr"), 2);
		const result = await readSelectedHqLookupRows(creds, "sample", table, {
			maxRows: 3,
			maxBytes: limits.maxBytes,
		});
		expect(result).toMatchObject({
			totalCount: 2,
			rows: [
				{
					id: first,
					sortKey: 5,
					itemAttributes: { region: "north" },
					fields: { name: [{ value: "A", properties: { lang: "en" } }] },
				},
				{
					id: second,
					sortKey: 5,
					itemAttributes: { region: "north" },
					fields: { name: [{ value: "A", properties: { lang: "fr" } }] },
				},
			],
		});
		// No unfiltered item list, peer-provided URL, or unrelated row may be requested.
		expect(
			new Set(
				peer
					.getCallHistory()
					?.calls()
					.map((call) => new URL(call.fullUrl).pathname),
			),
		).toEqual(
			new Set([
				list.split("?")[0],
				pathOf(first),
				pathOf(second),
				`${root}/lookup_table/v1/${id}/`,
			]),
		);
	});
});

it.each([
	"foreign-table",
	"inconsistent-order",
	"changed-property",
	"changed-id",
	"out-of-scope-tag",
] as const)("refuses the entire generation on %s", async (fault) => {
	await withHttpPeer(async (peer) => {
		reply(peer, `${root}/lookup_table/v1/${id}/`, definition);
		const bad = fault === "out-of-scope-tag";
		reply(
			peer,
			list,
			bad
				? {
						...page,
						objects: [
							{ ...page.objects[0], fixture_type: "other" },
							page.objects[1],
						],
					}
				: page,
		);
		if (!bad) {
			reply(
				peer,
				pathOf(first),
				fault === "changed-id"
					? rowOf(second, 1)
					: rowOf(
							first,
							1,
							"en",
							fault === "foreign-table" ? "9".repeat(32) : id,
						),
			);
			if (fault === "inconsistent-order" || fault === "changed-property")
				reply(
					peer,
					pathOf(second),
					rowOf(second, fault === "inconsistent-order" ? 0 : 2),
				);
			if (fault === "changed-property") {
				reply(peer, list, page);
				reply(peer, pathOf(first), rowOf(first, 1, "sw"));
				reply(peer, pathOf(second), rowOf(second, 2));
			}
		}
		const staged: LookupSourcePage[] = [];
		const result = await streamHqLookupTable(creds, "sample", table, {
			...limits,
			stage: async (page) => {
				staged.push(page);
				return true;
			},
		});
		expect(result).toMatchObject({
			success: false,
			cause: bad ? "malformed" : "moved",
		});
		expect(staged.length).toBe(fault === "changed-property" ? 1 : 0);
	});
});

it("checks a durable prefix before handing its successor to a restarted job", async () => {
	await withHttpPeer(async (peer) => {
		const secondPath = `${list}&offset=1`;
		const [a, b] = page.objects;
		const one = {
			meta: {
				offset: 0,
				total_count: 2,
				next: "https://unrelated.invalid/ignored",
			},
			objects: [a],
		};
		const two = {
			meta: { offset: 1, total_count: 2, next: null },
			objects: [b],
		};
		reply(peer, `${root}/lookup_table/v1/${id}/`, definition, 3);
		reply(peer, list, one, 3);
		reply(peer, secondPath, two, 3);
		reply(peer, pathOf(first), rowOf(first, 1), 3);
		reply(peer, pathOf(second), rowOf(second, 2), 3);
		const pages: LookupSourcePage[] = [];
		const interrupted = await streamHqLookupTable(creds, "sample", table, {
			...limits,
			stage: async (page) => {
				if (pages.length) return false;
				pages.push(page);
				return true;
			},
		});
		expect(interrupted).toMatchObject({ success: false });
		const resumed = await streamHqLookupTable(creds, "sample", table, {
			...limits,
			checkpoint: pages[0],
			stage: async (page) => {
				pages.push(page);
				return true;
			},
		});
		expect(resumed).toMatchObject({
			totalCount: 2,
			throughDigest: pages[1]?.throughDigest,
		});
		expect(pages.map((page) => [page.start, page.offset])).toEqual([
			[0, 1],
			[1, 2],
		]);
	});
});

it("retains a source reference when only the selected rich detail exceeds the inline budget", async () => {
	await withHttpPeer(async (peer) => {
		reply(peer, `${root}/lookup_table/v1/${id}/`, definition, 1);
		reply(peer, list, page, 2);
		reply(peer, pathOf(first), rowOf(first, 1, "a".repeat(850)), 1);
		reply(peer, pathOf(second), rowOf(second, 2), 1);
		expect(
			await readSelectedHqLookupRows(creds, "sample", table, {
				maxRows: 20,
				maxBytes: 800,
			}),
		).toEqual({ kind: "past-limit", by: "bytes", totalCount: 2 });
	});
});
