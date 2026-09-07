/** Real HTTP request/response handling; workbook compilation and ownership
 * consequences are exercised through MCP plus Postgres in uploadAppToHq. */
import { expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
	readMultipartRequest,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import {
	listHqLookupTables,
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
			},
			{ id: "two", tag: "villages", isGlobal: false, fields: ["name"] },
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
			).toEqual({ success: false, status: 502 });
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
		});
		expect(await listHqLookupTables(CREDS, DOMAIN)).toEqual({
			success: false,
			status: 502,
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
			},
		},
		{
			data: { code: 402, message: "Some rows were skipped" },
			expected: {
				success: false,
				status: 402,
				message: "Some rows were skipped",
				mayHaveLanded: true,
			},
		},
		...[{ code: 999 }, null, [], {}, { code: "200" }].map((data) => ({
			data,
			expected: {
				success: false,
				status: 502,
				message: "",
				mayHaveLanded: true,
			},
		})),
	];
	await withHttpPeer(async (peer) => {
		for (const { data } of cases)
			peer
				.get(HOST)
				.intercept({ path: UPLOAD, method: "POST" })
				.reply(200, JSON.stringify(data));
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
		peer
			.get(HOST)
			.intercept({ path: UPLOAD, method: "POST" })
			.reply(200, "<html>Sign in</html>");
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
			});
		for (const status of [503, 502])
			expect(
				await uploadLookupTableWorkbook(CREDS, DOMAIN, bytes, {
					replace: true,
				}),
			).toEqual({ success: false, status, message: "", mayHaveLanded: true });
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
		});
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual([HOST + UPLOAD]);
	});
});
