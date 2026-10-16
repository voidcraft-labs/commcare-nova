/** Real HTTP request/response handling; workbook compilation and ownership
 * consequences are exercised through MCP plus Postgres in uploadAppToHq. */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MockAgent } from "undici";
import { expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
	readMultipartRequest,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import {
	listHqLookupTables,
	readHqLookupTableRows,
	uploadLookupTableWorkbook,
} from "../hq/lookupTables";

const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: "india",
} as const;
const DOMAIN = "clinic",
	HOST = "https://india.commcarehq.org";
const LIST = "/a/clinic/api/lookup_table/v1/?limit=100",
	UPLOAD = "/a/clinic/fixtures/fixapi/";
const AUTH = { authorization: "ApiKey account:fixture-key" };
function workbook() {
	const book = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(
		book,
		XLSX.utils.aoa_to_sheet([["code"], ["001"]]),
		"Data",
	);
	return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

it("reads each inventory page from the selected space and projects all returned table identities", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET", headers: AUTH })
			.reply(200, {
				meta: { next: "?limit=100&offset=100" },
				objects: [
					{
						id: "one",
						tag: "facilities",
						is_global: true,
						fields: [{ field_name: "code" }, { name: "label" }],
					},
				],
			});
		peer
			.get(HOST)
			.intercept({
				path: "/a/clinic/api/lookup_table/v1/?limit=100&offset=100",
				method: "GET",
				headers: AUTH,
			})
			.reply(200, {
				meta: { next: null },
				objects: [
					{ id: "two", tag: "villages", is_global: false, fields: ["name"] },
				],
			});
		expect(await listHqLookupTables(CREDS, DOMAIN)).toEqual([
			{
				id: "one",
				tag: "facilities",
				isGlobal: true,
				fields: ["code", "label"],
				fieldProperties: { code: [], label: [] },
				itemAttributes: [],
			},
			{
				id: "two",
				tag: "villages",
				isGlobal: false,
				fields: ["name"],
				fieldProperties: { name: [] },
				itemAttributes: [],
			},
		]);
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual([
			HOST + LIST,
			`${HOST}/a/clinic/api/lookup_table/v1/?limit=100&offset=100`,
		]);
	});
});

it("accepts an explicitly complete empty inventory and rejects malformed envelopes, identities, and cursors", async () => {
	await withHttpPeer(async (peer) => {
		const malformed: unknown[] = [
			null,
			[],
			{},
			{ objects: [] },
			{ objects: [], meta: {} },
			{ objects: "none", meta: { next: null } },
			{ objects: [null], meta: { next: null } },
			{ objects: [{ id: "", tag: "facilities" }], meta: { next: null } },
			{ objects: [{ id: "one", tag: null }], meta: { next: null } },
		];
		for (const next of [
			"",
			7,
			"https://outside.invalid/",
			"/a/other/api/lookup_table/v1/",
			"/a/clinic/api/location/v1/",
			"https://account@india.commcarehq.org/a/clinic/api/lookup_table/v1/",
			"http://[",
			`${LIST}#fragment`,
		])
			malformed.push({ objects: [], meta: { next } });
		for (const data of malformed)
			peer
				.get(HOST)
				.intercept({ path: LIST, method: "GET" })
				.reply(200, JSON.stringify(data));
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(200, { objects: [], meta: { next: null } });
		for (const data of malformed)
			expect(
				await listHqLookupTables(CREDS, DOMAIN),
				JSON.stringify(data),
			).toMatchObject({ success: false, status: 502 });
		expect(await listHqLookupTables(CREDS, DOMAIN)).toEqual([]);
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual(Array(malformed.length + 1).fill(HOST + LIST));
	});
});

it("does not turn a late failed page into a partial inventory or follow an endless cursor forever", async () => {
	await withHttpPeer(async (peer) => {
		const page = {
			objects: [{ id: "one", tag: "known" }],
			meta: { next: LIST },
		};
		peer.get(HOST).intercept({ path: LIST, method: "GET" }).reply(200, page);
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(403, "No API access");
		expect(await listHqLookupTables(CREDS, DOMAIN)).toEqual({
			success: false,
			status: 403,
			edgeRefusal: false,
		});
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(200, page)
			.times(20);
		expect(await listHqLookupTables(CREDS, DOMAIN)).toEqual({
			success: false,
			status: 508,
		});
		expect(peer.getCallHistory()?.calls()).toHaveLength(22);
	});
});

it("classifies a disconnected or non-JSON inventory as unavailable", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.replyWithError(new Error("connection lost"));
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(200, "<html>Sign in</html>");
		expect(await listHqLookupTables(CREDS, DOMAIN)).toEqual({
			success: false,
			status: 503,
			cause: "network",
		});
		expect(await listHqLookupTables(CREDS, DOMAIN)).toEqual({
			success: false,
			status: 502,
			cause: "malformed",
		});
	});
});

it("does not follow an inventory redirect to another project space", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(302, "Moved", {
				headers: { location: "/a/other/api/lookup_table/v1/?limit=100" },
			});
		expect(await listHqLookupTables(CREDS, DOMAIN)).toEqual({
			success: false,
			status: 302,
			edgeRefusal: false,
		});
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual([HOST + LIST]);
	});
});

it("transmits actual workbook bytes and explicit replacement policy in an authenticated multipart request", async () => {
	const bytes = workbook();
	await withHttpPeer(async (peer) => {
		for (const replace of [true, false]) {
			const received: FormData[] = [];
			peer
				.get(HOST)
				.intercept({ path: UPLOAD, method: "POST", headers: AUTH })
				.reply(async (request) => {
					received.push(await readMultipartRequest(request));
					return {
						statusCode: 200,
						data: JSON.stringify({ code: 200, message: "Table(s) uploaded." }),
						responseOptions: {
							headers: { "content-type": "application/json" },
						},
					};
				});
			expect(
				await uploadLookupTableWorkbook(CREDS, DOMAIN, bytes, { replace }),
			).toEqual({ success: true, message: "Table(s) uploaded." });
			expect(received).toHaveLength(1);
			const parts = received[0];
			expect([...parts.keys()]).toEqual([
				"waf_padding",
				"file-to-upload",
				"replace",
			]);
			expect(parts.get("replace")).toBe(String(replace));
			expect(String(parts.get("waf_padding")).length).toBeGreaterThanOrEqual(
				8192,
			);
			const file = parts.get("file-to-upload");
			if (!(file instanceof Blob)) throw new Error("Expected workbook file");
			expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
		}
	});
});

it("distinguishes format rejection from partial acceptance and treats unrecognized upload verdicts as possibly landed", async () => {
	const bytes = workbook();
	const cases: { data: unknown; expected: object }[] = [
		{
			data: { code: 405, message: "Please fix the formatting" },
			expected: {
				success: false,
				status: 405,
				message: "Please fix the formatting",
				mayHaveLanded: false,
				upgradeRequired: false,
			},
		},
		{
			data: { code: 402, message: "Some rows were skipped" },
			expected: {
				success: false,
				status: 402,
				message: "Some rows were skipped",
				mayHaveLanded: true,
				upgradeRequired: false,
			},
		},
		...[{ code: 999 }, null, [], {}, { code: "200" }].map((data) => ({
			data,
			expected: {
				success: false,
				status: 502,
				message: "",
				mayHaveLanded: true,
				upgradeRequired: false,
			},
		})),
	];
	await withHttpPeer(async (peer) => {
		for (const { data } of cases)
			peer
				.get(HOST)
				.intercept({ path: UPLOAD, method: "POST" })
				.reply(200, JSON.stringify(data), {
					headers: { "content-type": "application/json" },
				});
		for (const { expected } of cases)
			expect(
				await uploadLookupTableWorkbook(CREDS, DOMAIN, bytes, {
					replace: true,
				}),
			).toEqual(expected);
	});
});

it("preserves uncertainty after transport failure, server failure or gateway timeout, while recognizing a refused permission check", async () => {
	const bytes = workbook();
	await withHttpPeer(async (peer) => {
		for (const status of [403, 500, 504])
			peer
				.get(HOST)
				.intercept({ path: UPLOAD, method: "POST" })
				.reply(
					status,
					status === 504
						? "<html><title>504 Gateway Time-out</title></html>"
						: "Refused",
				);
		peer
			.get(HOST)
			.intercept({ path: UPLOAD, method: "POST" })
			.replyWithError(new Error("connection lost"));
		/* A body that claims JSON and does not parse says nothing about what
		 * HQ did with the workbook. */
		peer
			.get(HOST)
			.intercept({ path: UPLOAD, method: "POST" })
			.reply(200, "{ not json", {
				headers: { "content-type": "application/json" },
			});
		for (const status of [403, 500, 504])
			expect(
				await uploadLookupTableWorkbook(CREDS, DOMAIN, bytes, {
					replace: true,
				}),
			).toEqual({
				success: false,
				status,
				edgeRefusal: status === 504,
				message: "",
				mayHaveLanded: status !== 403,
				upgradeRequired: false,
			});
		for (const status of [503, 502])
			expect(
				await uploadLookupTableWorkbook(CREDS, DOMAIN, bytes, {
					replace: true,
				}),
			).toEqual({
				success: false,
				status,
				message: "",
				mayHaveLanded: true,
				upgradeRequired: false,
			});
	});
});

it("rejects unroutable domains before either HTTP operation", async () => {
	await withHttpPeer(async (peer) => {
		expect(await listHqLookupTables(CREDS, "../outside")).toEqual({
			success: false,
			status: 400,
		});
		expect(
			await uploadLookupTableWorkbook(CREDS, "../outside", workbook(), {
				replace: true,
			}),
		).toEqual({
			success: false,
			status: 400,
			message: "",
			mayHaveLanded: false,
			upgradeRequired: false,
		});
		expect(peer.getCallHistory()?.calls()).toEqual([]);
	});
});

it("refuses an upload redirect without resending workbook bytes to another destination", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: UPLOAD, method: "POST" })
			.reply(307, "Moved", {
				headers: { location: "/a/other/fixtures/fixapi/" },
			});
		expect(
			await uploadLookupTableWorkbook(CREDS, DOMAIN, workbook(), {
				replace: true,
			}),
		).toEqual({
			success: false,
			status: 307,
			edgeRefusal: false,
			message: "",
			mayHaveLanded: true,
			upgradeRequired: false,
		});
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual([HOST + UPLOAD]);
	});
});

/*
 * HQ's own answers to the two reads the drift check makes, retained by the
 * lane under `proof/hq-reads/lookups/` (part 02, The retained HQ reads):
 * `plain`, a global table; `rich`, a table that is not global, with a field
 * property, a row attribute and both row shapes; `long`, 1,005 rows.
 */
const LOOKUPS = path.join(process.cwd(), "proof/hq-reads/lookups");

type RetainedAnswer =
	| {
			readonly status: number;
			readonly headers: Record<string, string>;
			readonly body: string;
	  }
	| { readonly exception: string };

function retained(name: string): RetainedAnswer {
	return JSON.parse(readFileSync(path.join(LOOKUPS, name), "utf8"));
}

/** Serve one retained answer; a view that raised answers 500, as HQ does. */
function serve(peer: MockAgent, requestPath: string, answer: RetainedAnswer) {
	const route = peer.get(HOST).intercept({ path: requestPath, method: "GET" });
	if ("exception" in answer) route.reply(500, "Internal Server Error");
	else route.reply(answer.status, answer.body, { headers: answer.headers });
}

function rowsPath(tableId: string): string {
	return `/a/clinic/api/fixture/v1/?fixture_type_id=${tableId}`;
}

async function retainedTables() {
	return withHttpPeer(async (peer) => {
		serve(peer, LIST, retained("lookup-tables.json"));
		const tables = await listHqLookupTables(CREDS, DOMAIN);
		if ("success" in tables) throw new Error("the retained list did not parse");
		return tables;
	});
}

function tableTagged(
	tables: Awaited<ReturnType<typeof retainedTables>>,
	tag: string,
) {
	const table = tables.find((candidate) => candidate.tag === tag);
	if (table === undefined) throw new Error(`no retained table ${tag}`);
	return table;
}

it("reads each table's field properties and row attributes from HQ's definition list", async () => {
	const tables = await retainedTables();
	expect(tableTagged(tables, "plain")).toMatchObject({ isGlobal: true });
	const rich = tableTagged(tables, "rich");
	expect(rich.isGlobal).toBe(false);
	expect(Object.values(rich.fieldProperties).flat().length).toBeGreaterThan(0);
	expect(rich.itemAttributes.length).toBeGreaterThan(0);
});

it("follows the relative cursor across both retained pages of a 1,005-row table and stops at its count", async () => {
	const long = tableTagged(await retainedTables(), "long");
	const first = retained("fixture-rows-long-1.json");
	if ("exception" in first) throw new Error("the first page is an answer");
	const next = (JSON.parse(first.body) as { meta: { next: string } }).meta.next;
	const result = await withHttpPeer(async (peer) => {
		serve(peer, rowsPath(long.id), first);
		serve(
			peer,
			new URL(next, `${HOST}${rowsPath(long.id)}`).pathname +
				new URL(next, `${HOST}${rowsPath(long.id)}`).search,
			retained("fixture-rows-long-2.json"),
		);
		return readHqLookupTableRows(CREDS, DOMAIN, long.id);
	});
	if ("success" in result) throw new Error("the rows read failed");
	expect(result.totalCount).toBe(1005);
	expect(result.rows).toHaveLength(1005);
	expect(new Set(result.rows.map((row) => row.id)).size).toBe(1005);
});

it("gives each page of a table's rows its own deadline, and still stops a page that stalls", async () => {
	const long = tableTagged(await retainedTables(), "long");
	const first = retained("fixture-rows-long-1.json");
	const second = retained("fixture-rows-long-2.json");
	if ("exception" in first || "exception" in second)
		throw new Error("the long pages are answers");
	const next = new URL(
		(JSON.parse(first.body) as { meta: { next: string } }).meta.next,
		`${HOST}${rowsPath(long.id)}`,
	);
	/* Two pages of 20 seconds each outlast one 30-second deadline, and a
	 * page of 31 seconds outlasts its own. */
	for (const [secondPageMs, expected] of [
		[20_000, { totalCount: 1005 }],
		[31_000, { success: false, cause: "timeout" }],
	] as const) {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			await withHttpPeer(async (peer) => {
				peer
					.get(HOST)
					.intercept({ path: rowsPath(long.id), method: "GET" })
					.reply(first.status, first.body, { headers: first.headers })
					.delay(20_000);
				peer
					.get(HOST)
					.intercept({ path: next.pathname + next.search, method: "GET" })
					.reply(second.status, second.body, { headers: second.headers })
					.delay(secondPageMs);
				const read = readHqLookupTableRows(CREDS, DOMAIN, long.id);
				await vi.advanceTimersByTimeAsync(20_000);
				await vi.advanceTimersByTimeAsync(secondPageMs);
				expect(await read).toMatchObject(expected);
			});
		} finally {
			vi.useRealTimers();
		}
	}
});

it("parses both of HQ's row shapes", async () => {
	const rich = tableTagged(await retainedTables(), "rich");
	const result = await withHttpPeer(async (peer) => {
		serve(peer, rowsPath(rich.id), retained("fixture-rows-rich.json"));
		return readHqLookupTableRows(CREDS, DOMAIN, rich.id);
	});
	if ("success" in result) throw new Error("the rows read failed");
	const shapes = result.rows.map((row) =>
		Object.values(row.fields).every((value) => typeof value === "string")
			? "single"
			: "listed",
	);
	expect(new Set(shapes)).toEqual(new Set(["single", "listed"]));
	const listed = result.rows.find((row) =>
		Object.values(row.fields).some(
			(value) => typeof value !== "string" && value.length > 1,
		),
	);
	expect(listed).toBeDefined();
});

it("refuses a failed page and any row shape HQ does not serve", async () => {
	const plain = tableTagged(await retainedTables(), "plain");
	await withHttpPeer(async (peer) => {
		serve(
			peer,
			rowsPath(plain.id),
			retained("fixture-rows-plain-after-column-added.json"),
		);
		expect(await readHqLookupTableRows(CREDS, DOMAIN, plain.id)).toMatchObject({
			success: false,
			status: 500,
		});
	});
	const answer = retained("fixture-rows-plain.json");
	if ("exception" in answer) throw new Error("the plain rows are an answer");
	const body = JSON.parse(answer.body) as {
		objects: { fields: Record<string, unknown> }[];
	};
	for (const fields of [{ code: 7 }, { code: { values: ["a"] } }]) {
		const edited = structuredClone(body);
		const [row] = edited.objects;
		if (row !== undefined) row.fields = fields;
		await withHttpPeer(async (peer) => {
			serve(peer, rowsPath(plain.id), {
				...answer,
				body: JSON.stringify(edited),
			});
			expect(
				await readHqLookupTableRows(CREDS, DOMAIN, plain.id),
			).toMatchObject({ success: false, status: 502 });
		});
	}
});

/*
 * HQ's own answers to the workbook upload, retained by the lane under
 * `proof/hq-reads/lookup-upload/` from its upload view: `workbook`, the
 * answer to `targeted-hq-side-lookup`'s first-publish workbook; and the two
 * requests that carry no workbook, `not-a-workbook` and `no-file`, which the
 * view refuses before it writes anything.
 */
const LOOKUP_UPLOAD = path.join(process.cwd(), "proof/hq-reads/lookup-upload");

it.each([
	["workbook.json", { success: true }],
	[
		"not-a-workbook.json",
		{
			success: false,
			status: 405,
			mayHaveLanded: false,
			upgradeRequired: false,
		},
	],
	[
		"no-file.json",
		{
			success: false,
			status: 405,
			mayHaveLanded: false,
			upgradeRequired: false,
		},
	],
] as const)(
	"reads HQ's retained upload answer %s by the verdict in its body",
	async (name, expected) => {
		const answer = JSON.parse(
			readFileSync(path.join(LOOKUP_UPLOAD, name), "utf8"),
		) as {
			readonly status: number;
			readonly headers: Record<string, string>;
			readonly body: string;
		};
		const verdict = await withHttpPeer(async (peer) => {
			peer
				.get(HOST)
				.intercept({ path: UPLOAD, method: "POST" })
				.reply(answer.status, answer.body, { headers: answer.headers });
			return uploadLookupTableWorkbook(CREDS, DOMAIN, workbook(), {
				replace: true,
			});
		});
		expect(verdict).toMatchObject(expected);
		/* HQ's own sentence is what the person reads, whichever way it went. */
		expect((verdict as { message: string }).message).toBe(
			(JSON.parse(answer.body) as { message: string }).message,
		);
	},
);

it("reads an OK answer that is not JSON as HQ's plan page, which wrote nothing", async () => {
	const verdict = await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: UPLOAD, method: "POST" })
			.reply(200, "<html><title>Upgrade Required</title></html>", {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		return uploadLookupTableWorkbook(CREDS, DOMAIN, workbook(), {
			replace: true,
		});
	});
	expect(verdict).toEqual({
		success: false,
		status: 426,
		message: "",
		mayHaveLanded: false,
		upgradeRequired: true,
	});
});
