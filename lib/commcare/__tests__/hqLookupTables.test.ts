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
	replyRetained,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { log } from "@/lib/logger";
import {
	HQ_LOOKUP_TABLE_ROWS_MAX_BYTES,
	HQ_LOOKUP_UPLOAD_ACK_MAX_BYTES,
	HQ_REFUSED_BODY_READ_MAX_BYTES,
} from "../hq/bounds";
import { classifyHqFailure } from "../hq/failure";
import {
	listHqLookupTables,
	readHqLookupTableRows,
	rowsHoldOtherThanOneValue,
	uploadLookupTableWorkbook,
} from "../hq/lookupTables";

const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: "india",
} as const;
const DOMAIN = "clinic",
	HOST = "https://india.commcarehq.org";
const LIST = "/a/clinic/api/lookup_table/v1/?limit=1000",
	UPLOAD = "/a/clinic/fixtures/fixapi/";
/** The limits every row read here takes: Nova's row cap and one table's byte bound. */
const LIMITS = {
	maxRows: 5_000,
	maxBytes: HQ_LOOKUP_TABLE_ROWS_MAX_BYTES,
} as const;
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

it("reads each inventory page from the selected space by its own offset, twice, and projects all returned table identities", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET", headers: AUTH })
			.reply(200, {
				/* Nova reads `next` as "more" and asks its own offset. */
				meta: { next: "https://outside.invalid/", offset: 0, total_count: 2 },
				objects: [
					{
						id: "one",
						tag: "facilities",
						is_global: true,
						fields: [{ field_name: "code" }, { name: "label" }],
					},
				],
			})
			.times(2);
		peer
			.get(HOST)
			.intercept({
				path: `${LIST}&offset=1`,
				method: "GET",
				headers: AUTH,
			})
			.reply(200, {
				meta: { next: null, offset: 1, total_count: 2 },
				objects: [
					{ id: "two", tag: "villages", is_global: false, fields: ["name"] },
				],
			})
			.times(2);
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
			`${HOST}${LIST}&offset=1`,
			HOST + LIST,
			`${HOST}${LIST}&offset=1`,
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
			{ objects: [], meta: { total_count: "0" } },
			{ objects: "none", meta: { next: null, total_count: 0 } },
			{ objects: [null], meta: { next: null, total_count: 1 } },
			{
				objects: [{ id: "", tag: "facilities" }],
				meta: { next: null, total_count: 1 },
			},
			{
				objects: [{ id: "one", tag: null }],
				meta: { next: null, total_count: 1 },
			},
			/* A page that names a total its rows do not reach, or another offset. */
			{ objects: [], meta: { next: null, total_count: 1 } },
			{ objects: [], meta: { next: null, offset: 5, total_count: 0 } },
		];
		/* `next` is "more" or "no more", never a URL Nova asks for: a page with
		 * more to come that holds no row, or names no offset, is malformed,
		 * whatever `next` names. */
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
			malformed.push({
				objects: [],
				meta: { next, offset: 0, total_count: 0 },
			});
		for (const data of malformed)
			peer
				.get(HOST)
				.intercept({ path: LIST, method: "GET" })
				.reply(200, JSON.stringify(data));
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(200, { objects: [], meta: { next: null, total_count: 0 } });
		for (const data of malformed)
			expect(
				await listHqLookupTables(CREDS, DOMAIN),
				JSON.stringify(data),
			).toEqual({ success: false, status: 502, cause: "malformed" });
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
		const table = (id: string) => ({
			id,
			tag: id,
			is_global: true,
			fields: ["code"],
		});
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(200, {
				objects: [table("one")],
				meta: { next: "more", offset: 0, total_count: 2 },
			});
		peer
			.get(HOST)
			.intercept({ path: `${LIST}&offset=1`, method: "GET" })
			.reply(403, "No API access");
		expect(await listHqLookupTables(CREDS, DOMAIN)).toEqual({
			success: false,
			status: 403,
			edgeRefusal: false,
			refusedBody: "No API access",
		});
		/* A list that names more on every page, each page a new table, ends
		 * at the page bound. */
		peer
			.get(HOST)
			.intercept({
				path: (requested) =>
					requested.startsWith("/a/clinic/api/lookup_table/v1/"),
				method: "GET",
			})
			.reply((request) => {
				const offset = Number(
					new URL(request.path, HOST).searchParams.get("offset") ?? "0",
				);
				return {
					statusCode: 200,
					data: JSON.stringify({
						objects: [table(`table-${offset}`)],
						meta: { next: "more", offset, total_count: 20_000 },
					}),
				};
			})
			.times(21);
		expect(await listHqLookupTables(CREDS, DOMAIN)).toEqual({
			success: false,
			status: 508,
			cause: "malformed",
		});
		expect(peer.getCallHistory()?.calls()).toHaveLength(23);
	});
});

it("classifies a disconnected or non-JSON inventory as unavailable", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.replyWithError(new Error("connection lost"))
			/* A read no answer began for is sent once more. */
			.times(2);
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
			cause: "browser-page",
		});
	});
});

it("does not follow an inventory redirect to another project space", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(302, "Moved", {
				headers: { location: "/a/other/api/lookup_table/v1/?limit=1000" },
			});
		expect(await listHqLookupTables(CREDS, DOMAIN)).toEqual({
			success: false,
			status: 302,
			edgeRefusal: false,
			refusedBody: "Moved",
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
 * lane under `proof/hq-reads/lookups/`: `plain`, a global table; `rich`, a table that is not global, with a field
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

/** Serve one retained answer `times` times; a view that raised answers 500, as HQ does. */
function serve(
	peer: MockAgent,
	requestPath: string,
	answer: RetainedAnswer,
	times = 1,
) {
	const route = peer.get(HOST).intercept({ path: requestPath, method: "GET" });
	if ("exception" in answer)
		route.reply(500, "Internal Server Error").times(times);
	else
		route
			.reply(answer.status, answer.body, { headers: answer.headers })
			.times(times);
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

it("reads both retained pages of a 1,005-row table by its own offset, twice, and stops at its count", async () => {
	const long = tableTagged(await retainedTables(), "long");
	const result = await withHttpPeer(async (peer) => {
		serve(peer, rowsPath(long.id), retained("fixture-rows-long-1.json"), 2);
		serve(
			peer,
			`${rowsPath(long.id)}&offset=1000`,
			retained("fixture-rows-long-2.json"),
			2,
		);
		return readHqLookupTableRows(CREDS, DOMAIN, long, LIMITS);
	});
	if ("success" in result || "kind" in result)
		throw new Error("the rows read failed");
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
	/* Two pages of 20 seconds each outlast one 30-second deadline, and a
	 * page of 31 seconds outlasts its own. */
	for (const [secondPageMs, expected] of [
		[20_000, { totalCount: 1005 }],
		[31_000, { success: false, cause: "timeout" }],
	] as const) {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			await withHttpPeer(async (peer) => {
				/* The read of a table of two pages makes two passes; one whose
				 * second page stalls ends with the first pass. */
				const passes = secondPageMs > 30_000 ? 1 : 2;
				peer
					.get(HOST)
					.intercept({ path: rowsPath(long.id), method: "GET" })
					.reply(first.status, first.body, { headers: first.headers })
					.delay(20_000)
					.times(passes);
				peer
					.get(HOST)
					.intercept({
						path: `${rowsPath(long.id)}&offset=1000`,
						method: "GET",
					})
					.reply(second.status, second.body, { headers: second.headers })
					.delay(secondPageMs)
					.times(passes);
				const read = readHqLookupTableRows(CREDS, DOMAIN, long, LIMITS);
				for (let pass = 0; pass < passes; pass++) {
					await vi.advanceTimersByTimeAsync(20_000);
					await vi.advanceTimersByTimeAsync(secondPageMs);
				}
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
		return readHqLookupTableRows(CREDS, DOMAIN, rich, LIMITS);
	});
	if ("success" in result || "kind" in result)
		throw new Error("the rows read failed");
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
		expect(
			await readHqLookupTableRows(CREDS, DOMAIN, plain, LIMITS),
		).toMatchObject({
			success: false,
			status: 500,
		});
	});
	const answer = retained("fixture-rows-plain.json");
	if ("exception" in answer) throw new Error("the plain rows are an answer");
	const body = JSON.parse(answer.body) as {
		objects: Record<string, unknown>[];
	};
	for (const edit of [
		(row: Record<string, unknown>) => {
			row.fields = { code: 7 };
		},
		(row: Record<string, unknown>) => {
			row.fields = { code: { values: ["a"] } };
		},
		/* A row of another table is no row of this one. */
		(row: Record<string, unknown>) => {
			row.fixture_type = "rich";
		},
		(row: Record<string, unknown>) => {
			delete row.fixture_type;
		},
	]) {
		const edited = structuredClone(body);
		const [row] = edited.objects;
		if (row !== undefined) edit(row);
		await withHttpPeer(async (peer) => {
			serve(peer, rowsPath(plain.id), {
				...answer,
				body: JSON.stringify(edited),
			});
			expect(
				await readHqLookupTableRows(CREDS, DOMAIN, plain, LIMITS),
			).toMatchObject({ success: false, status: 502 });
		});
	}
});

it("reads a field named __proto__ like any other field, in the definition and in both row shapes", async () => {
	/* JSON.parse makes `__proto__` an own key, as it does of HQ's answer;
	 * an object literal would set the prototype instead. */
	const list = retained("lookup-tables.json");
	if ("exception" in list) throw new Error("the table list is an answer");
	const listBody = JSON.parse(list.body) as {
		objects: Record<string, unknown>[];
	};
	const [first] = listBody.objects;
	if (first === undefined) throw new Error("the retained list holds a table");
	first.fields = JSON.parse(
		'[{"field_name":"__proto__","properties":["lang"]},{"field_name":"code","properties":[]}]',
	);
	const tables = await withHttpPeer(async (peer) => {
		serve(peer, LIST, { ...list, body: JSON.stringify(listBody) });
		return listHqLookupTables(CREDS, DOMAIN);
	});
	if ("success" in tables) throw new Error("the edited list did not parse");
	const [table] = tables;
	expect(table?.fields).toEqual(["__proto__", "code"]);
	// No prototype: an index by a field's name answers that field alone.
	expect(Object.getPrototypeOf(table?.fieldProperties)).toBeNull();
	const proto = "__proto__";
	expect(table?.fieldProperties[proto]).toEqual(["lang"]);
	expect(Object.entries(table?.fieldProperties ?? {})).toEqual([
		["__proto__", ["lang"]],
		["code", []],
	]);

	const plain = tableTagged(await retainedTables(), "plain");
	const rows = retained("fixture-rows-plain.json");
	if ("exception" in rows) throw new Error("the plain rows are an answer");
	for (const [fields, expected] of [
		[
			'{"__proto__":"x","code":"1"}',
			[
				["__proto__", "x"],
				["code", "1"],
			],
		],
		[
			'{"__proto__":{"field_list":[{"field_value":"a","properties":{}}]},"code":{"field_list":[{"field_value":"b","properties":{}}]}}',
			[
				["__proto__", [{ value: "a", properties: {} }]],
				["code", [{ value: "b", properties: {} }]],
			],
		],
	] as const) {
		const body = JSON.parse(rows.body) as {
			objects: { fields: unknown }[];
		};
		const [row] = body.objects;
		if (row === undefined) throw new Error("the plain rows hold a row");
		row.fields = JSON.parse(fields);
		const read = await withHttpPeer(async (peer) => {
			serve(peer, rowsPath(plain.id), { ...rows, body: JSON.stringify(body) });
			return readHqLookupTableRows(CREDS, DOMAIN, plain, LIMITS);
		});
		if ("success" in read || "kind" in read)
			throw new Error("the edited rows did not parse");
		const read0 = read.rows[0]?.fields;
		expect(Object.getPrototypeOf(read0)).toBeNull();
		expect(Object.entries(read0 ?? {})).toEqual(expected);
	}
});

it("refuses a definition it would otherwise read with a default", async () => {
	const answer = retained("lookup-tables.json");
	if ("exception" in answer) throw new Error("the table list is an answer");
	const body = JSON.parse(answer.body) as {
		objects: Record<string, unknown>[];
	};
	const edits: readonly ((table: Record<string, unknown>) => void)[] = [
		(table) => {
			(table.fields as Record<string, unknown>[])[0].properties = "label";
		},
		(table) => {
			(table.fields as Record<string, unknown>[])[0] = { properties: [] };
		},
		(table) => {
			table.is_global = "yes";
		},
		(table) => {
			table.item_attributes = [7];
		},
	];
	for (const edit of edits) {
		const edited = structuredClone(body);
		edit(edited.objects[0]);
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, { ...answer, body: JSON.stringify(edited) });
			expect(await listHqLookupTables(CREDS, DOMAIN)).toEqual({
				success: false,
				status: 502,
				cause: "malformed",
			});
		});
	}
});

it("keeps the plan refusal's body, so it reads as the plan and never as the key", async () => {
	const refusal = await withHttpPeer(async (peer) => {
		replyRetained(
			peer.get(HOST).intercept({ path: LIST, method: "GET" }),
			retainedReadingRead("api-access-no-plan"),
		);
		return listHqLookupTables(CREDS, DOMAIN);
	});
	if (!("success" in refusal)) throw new Error("the refusal read as a list");
	expect(classifyHqFailure(refusal, "lookup-tables").kind).toBe(
		"plan-lacks-api-access",
	);
});

it("tells rows that hold other than one value in a field from rows that hold one", async () => {
	const rowsOf = async (tag: string, file: string) => {
		const table = tableTagged(await retainedTables(), tag);
		const result = await withHttpPeer(async (peer) => {
			serve(peer, rowsPath(table.id), retained(file));
			return readHqLookupTableRows(CREDS, DOMAIN, table, LIMITS);
		});
		if ("success" in result || "kind" in result)
			throw new Error(`${file} did not read`);
		return result.rows;
	};
	expect(
		rowsHoldOtherThanOneValue(await rowsOf("rich", "fixture-rows-rich.json")),
	).toBe(true);
	expect(
		rowsHoldOtherThanOneValue(await rowsOf("plain", "fixture-rows-plain.json")),
	).toBe(false);
});

it("stops a row read past the caller's row limit at the first page's total, and reads every page twice at it", async () => {
	const long = tableTagged(await retainedTables(), "long");
	const first = retained("fixture-rows-long-1.json");
	await withHttpPeer(async (peer) => {
		serve(peer, rowsPath(long.id), first);
		expect(
			await readHqLookupTableRows(CREDS, DOMAIN, long, {
				...LIMITS,
				maxRows: 1004,
			}),
		).toEqual({ kind: "past-limit", by: "rows", totalCount: 1005 });
		expect(peer.getCallHistory()?.calls()).toHaveLength(1);
	});
	await withHttpPeer(async (peer) => {
		serve(peer, rowsPath(long.id), first, 2);
		serve(
			peer,
			`${rowsPath(long.id)}&offset=1000`,
			retained("fixture-rows-long-2.json"),
			2,
		);
		const whole = await readHqLookupTableRows(CREDS, DOMAIN, long, {
			...LIMITS,
			maxRows: 1005,
		});
		expect(whole).toMatchObject({ totalCount: 1005 });
		expect("rows" in whole && whole.rows).toHaveLength(1005);
		expect(peer.getCallHistory()?.calls()).toHaveLength(4);
	});
});

it("stops a row read whose pages pass its byte bound, and holds no row of it", async () => {
	const long = tableTagged(await retainedTables(), "long");
	const first = retained("fixture-rows-long-1.json");
	if ("exception" in first) throw new Error("the first page is an answer");
	const firstBytes = Buffer.byteLength(first.body);
	/* The first page alone passes the bound: no total was read. */
	await withHttpPeer(async (peer) => {
		serve(peer, rowsPath(long.id), first);
		expect(
			await readHqLookupTableRows(CREDS, DOMAIN, long, {
				...LIMITS,
				maxBytes: firstBytes - 1,
			}),
		).toEqual({ kind: "past-limit", by: "bytes", totalCount: null });
	});
	/* The second page passes what remains of it: the first page's total. */
	await withHttpPeer(async (peer) => {
		serve(peer, rowsPath(long.id), first);
		serve(
			peer,
			`${rowsPath(long.id)}&offset=1000`,
			retained("fixture-rows-long-2.json"),
		);
		expect(
			await readHqLookupTableRows(CREDS, DOMAIN, long, {
				...LIMITS,
				maxBytes: firstBytes + 10,
			}),
		).toEqual({ kind: "past-limit", by: "bytes", totalCount: 1005 });
		expect(peer.getCallHistory()?.calls()).toHaveLength(2);
	});
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

it("logs a refused workbook by HQ's code and its message's shape and length, and a failed one by its body's, never their words", async () => {
	const words = "Table “maternal_visit_sites” has a row with no site name";
	const message = `Upload failed: ${words}`;
	const failed = `<p>Server error while reading ${words}</p>`;
	const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: UPLOAD, method: "POST" })
			.reply(200, JSON.stringify({ code: 405, message }), {
				headers: { "content-type": "application/json" },
			});
		peer
			.get(HOST)
			.intercept({ path: UPLOAD, method: "POST" })
			.reply(500, failed);
		/* What a person is shown keeps HQ's sentence; only the log loses it. */
		expect(
			await uploadLookupTableWorkbook(CREDS, DOMAIN, workbook(), {
				replace: true,
			}),
		).toMatchObject({ success: false, status: 405, message });
		expect(
			await uploadLookupTableWorkbook(CREDS, DOMAIN, workbook(), {
				replace: true,
			}),
		).toMatchObject({ success: false, status: 500, mayHaveLanded: true });
	});
	expect(vi.mocked(log.error).mock.calls).toEqual([
		[
			"[commcare] lookup table upload refused",
			undefined,
			{
				domain: DOMAIN,
				code: 405,
				message: "text",
				messageBytes: bytesOf(message),
			},
		],
		[
			"[commcare] lookup table upload failed",
			undefined,
			{
				status: 500,
				edgeRefusal: false,
				body: "page",
				bodyBytes: bytesOf(failed),
				bodyCutOff: false,
			},
		],
	]);
	expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain(
		"maternal_visit_sites",
	);
});

it("reads a refused workbook's body only as far as refusals are read, and still says what may have landed", async () => {
	const page = `<html>${"x".repeat(HQ_REFUSED_BODY_READ_MAX_BYTES * 4)}</html>`;
	await withHttpPeer(async (peer) => {
		peer.get(HOST).intercept({ path: UPLOAD, method: "POST" }).reply(500, page);
		expect(
			await uploadLookupTableWorkbook(CREDS, DOMAIN, workbook(), {
				replace: true,
			}),
		).toMatchObject({ success: false, status: 500, mayHaveLanded: true });
	});
	expect(vi.mocked(log.error).mock.calls).toEqual([
		[
			"[commcare] lookup table upload failed",
			undefined,
			expect.objectContaining({ bodyCutOff: true }),
		],
	]);
});

it("takes a verdict longer than Nova reads as an answer it cannot read, which may have landed", async () => {
	const verdict = JSON.stringify({
		code: 200,
		message: "x".repeat(HQ_LOOKUP_UPLOAD_ACK_MAX_BYTES),
	});
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: UPLOAD, method: "POST" })
			.reply(200, verdict, { headers: { "content-type": "application/json" } });
		expect(
			await uploadLookupTableWorkbook(CREDS, DOMAIN, workbook(), {
				replace: true,
			}),
		).toEqual({
			success: false,
			status: 502,
			message: "",
			mayHaveLanded: true,
			upgradeRequired: false,
		});
	});
});
