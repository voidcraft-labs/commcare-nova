/**
 * `readHqLookupTablesForReading` over CommCare HQ's own answers, retained
 * under `proof/hq-reads/`, served through a controlled peer to the production
 * readers: which tables' rows are asked for, where a long table stops, and
 * which failed row read is the table's own fault.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { classifyHqFailure } from "@/lib/commcare/hq/failure";
import { canonicalLookupTable } from "../../../hqResourceBaseline";
import { readHqLookupTablesForReading } from "../lookupTableStore";

const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: "india",
} as const;
const HOST = "https://india.commcarehq.org";
const READS = path.join(process.cwd(), "proof/hq-reads");
const LIST = "/a/clinic/api/lookup_table/v1/?limit=1000";
const PLAIN_ID = "09948f8373da4c86a86b7707a0e9fbcd";
const RICH_ID = "9ea70d486f644cc4a2f22c063294e197";
const LONG_ID = "a0a2cdc1f69941da848befc33ffc36be";

type Retained =
	| {
			readonly status: number;
			readonly headers: Record<string, string>;
			readonly body: string;
	  }
	| { readonly exception: string };

function retained(relative: string): Retained {
	return JSON.parse(readFileSync(path.join(READS, relative), "utf8"));
}

function rowsPath(tableId: string): string {
	return `/a/clinic/api/fixture/v1/?fixture_type_id=${tableId}`;
}

/** Serve one retained answer once; an exception CommCare HQ raised is its 500. */
function serve(peer: MockAgent, requestPath: string, answer: Retained): void {
	const route = peer.get(HOST).intercept({ path: requestPath, method: "GET" });
	if ("exception" in answer) route.reply(500, "Internal Server Error");
	else route.reply(answer.status, answer.body, { headers: answer.headers });
}

function serveStatus(
	peer: MockAgent,
	requestPath: string,
	status: number,
): void {
	peer
		.get(HOST)
		.intercept({ path: requestPath, method: "GET" })
		.reply(status, "Unavailable");
}

function calls(peer: MockAgent): readonly string[] {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map((call) => call.fullUrl.slice(HOST.length)) ?? []
	);
}

describe("readHqLookupTablesForReading", () => {
	it("reads rows for the tables the source names alone, one table at a time", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retained("lookups/lookup-tables.json"));
			serve(
				peer,
				rowsPath(PLAIN_ID),
				retained("lookups/fixture-rows-plain.json"),
			);
			serve(
				peer,
				rowsPath(RICH_ID),
				retained("lookups/fixture-rows-rich.json"),
			);
			const listBody = retained("lookups/lookup-tables.json"),
				rich = retained("lookups/fixture-rows-rich.json");
			if ("exception" in listBody || "exception" in rich)
				throw new Error("Expected HQ answers");
			const def = JSON.parse(listBody.body).objects.find(
				(value: { id: string }) => value.id === RICH_ID,
			);
			const detailPath = (id: string) =>
				`/a/clinic/api/lookup_table_item/v1/${id}/`;
			const defPath = `/a/clinic/api/lookup_table/v1/${RICH_ID}/`;
			const items = JSON.parse(rich.body).objects as {
				id: string;
				fields: Record<string, unknown>;
			}[];
			// The rich values are the ones persisted by proof/hq/test_retained_reads.py::_shape_rich.
			for (let pass = 0; pass < 2; pass++) {
				peer
					.get(HOST)
					.intercept({ path: defPath, method: "GET" })
					.reply(200, def);
				serve(peer, rowsPath(RICH_ID), rich);
				for (const [index, item] of items.entries()) {
					peer
						.get(HOST)
						.intercept({ path: detailPath(item.id), method: "GET" })
						.reply(200, {
							id: item.id,
							data_type_id: RICH_ID,
							sort_key: index,
							item_attributes: { zone: index === 0 ? "upland" : "coastal" },
							fields:
								index === 0
									? {
											code: {
												field_list: [{ field_value: "north", properties: {} }],
											},
											name: {
												field_list: [
													{ field_value: "North", properties: { lang: "en" } },
												],
											},
										}
									: item.fields,
						});
				}
			}
			const answer = await readHqLookupTablesForReading({
				creds: CREDS,
				domain: "clinic",
				referencedTags: async () => new Set(["plain", "rich"]),
			});
			if ("success" in answer) throw new Error("the read failed");
			expect(
				answer.tables.map((table) => [table.kind, table.table.tag]),
			).toEqual([
				["read", "plain"],
				["read", "rich"],
			]);
			const [plain] = answer.tables;
			if (plain?.kind !== "read") throw new Error("plain was not read");
			expect(plain.rows.map((row) => row.fields)).toEqual([
				{ code: "001", name: "Clinic" },
				{ code: "002", name: "Hospital" },
			]);
			expect(plain.canonical).toEqual(
				canonicalLookupTable(plain.table, plain.rows),
			);
			expect(calls(peer)).toEqual([
				LIST,
				rowsPath(PLAIN_ID),
				rowsPath(RICH_ID),
				defPath,
				rowsPath(RICH_ID),
				...items.map((row) => detailPath(row.id)),
				rowsPath(RICH_ID),
				...items.map((row) => detailPath(row.id)),
				defPath,
			]);
		});
	});

	it("stops a table whose first page names more rows than Nova holds after that one request", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retained("lookups/lookup-tables.json"));
			const page = retained("lookups/fixture-rows-plain.json");
			if ("exception" in page)
				throw new Error("the retained page is an exception");
			const body = JSON.parse(page.body) as { meta: Record<string, unknown> };
			body.meta.total_count = 5_001;
			body.meta.next = `/a/clinic/api/fixture/v1/?fixture_type_id=${LONG_ID}&limit=1000&offset=1000`;
			serve(peer, rowsPath(LONG_ID), { ...page, body: JSON.stringify(body) });
			const answer = await readHqLookupTablesForReading({
				creds: CREDS,
				domain: "clinic",
				referencedTags: async () => new Set(["long"]),
			});
			if ("success" in answer) throw new Error("the read failed");
			expect(answer.tables).toEqual([
				{
					kind: "over-row-limit",
					table: expect.objectContaining({ tag: "long", id: LONG_ID }),
					totalCount: 5_001,
				},
			]);
			expect(calls(peer)).toEqual([LIST, rowsPath(LONG_ID)]);
		});
	});

	const plainOnly = {
		creds: CREDS,
		domain: "clinic",
		referencedTags: async () => new Set(["plain"]),
	};

	it("sends a row read CommCare HQ did not answer once more, and reads the rows the second time", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retained("lookups/lookup-tables.json"));
			serveStatus(peer, rowsPath(PLAIN_ID), 503);
			serve(
				peer,
				rowsPath(PLAIN_ID),
				retained("lookups/fixture-rows-plain.json"),
			);
			const answer = await readHqLookupTablesForReading(plainOnly);
			if ("success" in answer) throw new Error("the read failed");
			expect(answer.tables.map((table) => table.kind)).toEqual(["read"]);
		});
		/* `readHqJson` sends a read no answer began for once more itself, so
		 * the store's own second send is the third request. */
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retained("lookups/lookup-tables.json"));
			peer
				.get(HOST)
				.intercept({ path: rowsPath(PLAIN_ID), method: "GET" })
				.replyWithError(new Error("connection reset"))
				.times(2);
			serve(
				peer,
				rowsPath(PLAIN_ID),
				retained("lookups/fixture-rows-plain.json"),
			);
			const answer = await readHqLookupTablesForReading(plainOnly);
			if ("success" in answer) throw new Error("the read failed");
			expect(answer.tables.map((table) => table.kind)).toEqual(["read"]);
			expect(calls(peer)).toEqual([
				LIST,
				rowsPath(PLAIN_ID),
				rowsPath(PLAIN_ID),
				rowsPath(PLAIN_ID),
			]);
		});
	});

	it("answers a row read that never gets an answer as CommCare HQ unavailable, after four sends", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retained("lookups/lookup-tables.json"));
			peer
				.get(HOST)
				.intercept({ path: rowsPath(PLAIN_ID), method: "GET" })
				.replyWithError(new Error("connection reset"))
				.times(4);
			const answer = await readHqLookupTablesForReading(plainOnly);
			if (!("success" in answer)) throw new Error("the read did not fail");
			expect(answer).toMatchObject({
				status: 503,
				cause: "network",
				request: "lookup-rows",
			});
			expect(classifyHqFailure(answer, "lookup-rows").kind).toBe(
				"hq-unavailable",
			);
			expect(calls(peer)).toEqual([LIST, ...Array(4).fill(rowsPath(PLAIN_ID))]);
		});
	});

	it("finds a table's rows unreadable where CommCare HQ fails the read twice for a row with a field with no value", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retained("lookups/lookup-tables.json"));
			serve(
				peer,
				rowsPath(PLAIN_ID),
				retained("reading/fixture-rows-empty-field.json"),
			);
			serve(
				peer,
				rowsPath(PLAIN_ID),
				retained("reading/fixture-rows-empty-field.json"),
			);
			const answer = await readHqLookupTablesForReading(plainOnly);
			if ("success" in answer) throw new Error("the read failed");
			expect(answer.tables).toEqual([
				{
					kind: "rows-unreadable",
					table: expect.objectContaining({ tag: "plain" }),
				},
			]);
		});
	});

	it("answers the second failure where one of the two is an outage, which is CommCare HQ unavailable", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retained("lookups/lookup-tables.json"));
			serve(
				peer,
				rowsPath(PLAIN_ID),
				retained("reading/fixture-rows-empty-field.json"),
			);
			serveStatus(peer, rowsPath(PLAIN_ID), 503);
			const answer = await readHqLookupTablesForReading(plainOnly);
			if (!("success" in answer)) throw new Error("the read did not fail");
			expect(answer.status).toBe(503);
			expect(classifyHqFailure(answer, "lookup-rows").kind).toBe(
				"hq-unavailable",
			);
		});
	});

	it("does not send a refused row read again", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retained("lookups/lookup-tables.json"));
			serveStatus(peer, rowsPath(PLAIN_ID), 404);
			const answer = await readHqLookupTablesForReading(plainOnly);
			if (!("success" in answer)) throw new Error("the read did not fail");
			expect(answer.status).toBe(404);
			expect(calls(peer)).toEqual([LIST, rowsPath(PLAIN_ID)]);
		});
	});

	it("returns a failed list read as the error, and asks for no rows", async () => {
		await withHttpPeer(async (peer) => {
			serveStatus(peer, LIST, 500);
			const answer = await readHqLookupTablesForReading(plainOnly);
			if (!("success" in answer)) throw new Error("the read did not fail");
			expect(answer.status).toBe(500);
			expect(calls(peer)).toEqual([LIST]);
		});
	});
});
