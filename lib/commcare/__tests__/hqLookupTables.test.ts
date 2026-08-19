/**
 * Fetch-level tests for the CommCare HQ lookup-table driver
 * (`lib/commcare/hq/lookupTables.ts`).
 *
 * The wire shape is verified against HQ's own source, not a hand-rolled
 * echo of Nova's assumptions:
 *
 *   - reading is the tastypie resource at
 *     `/a/{domain}/api/lookup_table/v1/` (`api/urls.py`, resource-first
 *     versioning; `fixtures/resources/v0_1.py::LookupTableResource`),
 *     answering the standard `{meta: {next}, objects: [...]}` envelope,
 *   - writing is `POST /a/{domain}/fixtures/fixapi/`
 *     (`fixtures/urls.py`), multipart `file-to-upload` + `replace`
 *     (`views.py::_get_fixture_upload_args_from_request`),
 *   - and its verdict is in the BODY: `views.py::UploadFixtureAPIResponse`
 *     maps fail/warning/success to 405/402/200 and `JsonResponse` carries
 *     every one of them over HTTP 200, so reading the HTTP status alone
 *     reports every refusal as a success.
 *
 * `waf_padding` leads the upload's multipart body for the reason #481
 * established on the two existing uploads: `@waf_allow('XSS_BODY')` only
 * registers the view in a dict (`hqwebapp/decorators.py::waf_allow`) and
 * wraps nothing, and compressed archive bytes already tripped the rule
 * once. An `.xlsx` is a ZIP.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	listHqLookupTables,
	uploadLookupTableWorkbook,
} from "../hq/lookupTables";

const CREDS = {
	username: "user@example.org",
	apiKey: "abc123",
	server: "production",
} as const;
const DOMAIN = "myproject";
const WORKBOOK = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("listHqLookupTables", () => {
	let fetchMock: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		fetchMock = vi.spyOn(globalThis, "fetch");
	});
	afterEach(() => {
		fetchMock.mockRestore();
	});

	it("reads the resource-first v1 path with the ApiKey header", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				meta: { next: null },
				objects: [
					{
						id: "abc",
						tag: "districts",
						is_global: true,
						fields: [{ field_name: "code" }, { field_name: "name" }],
					},
				],
			}),
		);

		const result = await listHqLookupTables(CREDS, DOMAIN);
		expect(result).toEqual([
			{
				id: "abc",
				tag: "districts",
				isGlobal: true,
				fields: ["code", "name"],
			},
		]);
		const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
		expect(String(call[0])).toBe(
			`https://www.commcarehq.org/a/${DOMAIN}/api/lookup_table/v1/?limit=100`,
		);
		expect((call[1].headers as Record<string, string>).Authorization).toBe(
			`ApiKey ${CREDS.username}:${CREDS.apiKey}`,
		);
	});

	it("follows meta.next until the pages run out", async () => {
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({
					meta: {
						next: "/a/myproject/api/lookup_table/v1/?limit=100&offset=100",
					},
					objects: [{ id: "one", tag: "a", is_global: true, fields: [] }],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					meta: { next: null },
					objects: [{ id: "two", tag: "b", is_global: true, fields: [] }],
				}),
			);

		const result = await listHqLookupTables(CREDS, DOMAIN);
		expect(Array.isArray(result) && result.map((table) => table.tag)).toEqual([
			"a",
			"b",
		]);
		expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
			`https://www.commcarehq.org/a/${DOMAIN}/api/lookup_table/v1/?limit=100&offset=100`,
		);
	});

	it("refuses to follow a cursor off CommCare HQ", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				meta: {
					next: "https://attacker.example/a/myproject/api/lookup_table/v1/",
				},
				objects: [],
			}),
		);
		expect(await listHqLookupTables(CREDS, DOMAIN)).toEqual({
			success: false,
			status: 502,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reports a refusal rather than answering that there are none", async () => {
		/* The whole point of the read: "no tables came back" and "you may not
		 * ask" must never collapse to the same answer, because one of them
		 * would let a publish take over somebody else's table. */
		fetchMock.mockResolvedValue(new Response("", { status: 403 }));
		expect(await listHqLookupTables(CREDS, DOMAIN)).toMatchObject({
			success: false,
			status: 403,
		});
	});

	it("rejects a domain slug that is not one before any request goes out", async () => {
		expect(await listHqLookupTables(CREDS, "../evil")).toEqual({
			success: false,
			status: 400,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("uploadLookupTableWorkbook", () => {
	let fetchMock: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		fetchMock = vi.spyOn(globalThis, "fetch");
	});
	afterEach(() => {
		fetchMock.mockRestore();
	});

	it("POSTs the workbook to fixapi with waf_padding FIRST", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ code: 200, message: "Table(s) uploaded." }),
		);

		const result = await uploadLookupTableWorkbook(CREDS, DOMAIN, WORKBOOK, {
			replace: true,
		});
		expect(result).toEqual({ success: true, message: "Table(s) uploaded." });

		const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
		expect(String(call[0])).toBe(
			`https://www.commcarehq.org/a/${DOMAIN}/fixtures/fixapi/`,
		);
		expect(call[1].method).toBe("POST");
		const body = call[1].body as FormData;
		expect([...body.keys()]).toEqual([
			"waf_padding",
			"file-to-upload",
			"replace",
		]);
		expect(body.get("replace")).toBe("true");
		const file = body.get("file-to-upload") as File;
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(WORKBOOK);
	});

	it("sends replace=false when asked, in CommCare HQ's own spelling", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ code: 200, message: "ok" }));
		await uploadLookupTableWorkbook(CREDS, DOMAIN, WORKBOOK, {
			replace: false,
		});
		const body = (fetchMock.mock.calls.at(-1) as [string, RequestInit])[1]
			.body as FormData;
		expect(body.get("replace")).toBe("false");
	});

	it("reads the verdict from the body, not the HTTP status", async () => {
		/* `UploadFixtureAPIResponse.response_codes` puts fail at 405 INSIDE a
		 * 200 JsonResponse. A driver reading only the transport would call
		 * this a successful push and send the app after it.
		 *
		 * The message travels with it. `_upload_fixture_api` answers a fail
		 * with the formatting complaint `validate_fixture_file_format`
		 * raised, which names the sheet or the column Nova could not have
		 * guessed at — the whole reason this path is synchronous. */
		fetchMock.mockResolvedValue(
			jsonResponse({ code: 405, message: "Please fix the formatting" }),
		);
		expect(
			await uploadLookupTableWorkbook(CREDS, DOMAIN, WORKBOOK, {
				replace: true,
			}),
		).toEqual({
			success: false,
			status: 405,
			message: "Please fix the formatting",
			/* A fail is raised BEFORE `upload_fixture_file` runs, so nothing
			 * reached the project space and there is nothing to claim. */
			mayHaveLanded: false,
		});
	});

	it("treats CommCare HQ's warning verdict as a refusal that still landed", async () => {
		/* A warning means some rows landed and some did not. Nova pushes whole
		 * tables, so a partial result is a project space whose data no longer
		 * matches the app that was about to be sent to it — and it is also a
		 * project space that now HOLDS those tables, which the caller has to
		 * record rather than walk away from. */
		fetchMock.mockResolvedValue(
			jsonResponse({ code: 402, message: "Some rows were skipped" }),
		);
		expect(
			await uploadLookupTableWorkbook(CREDS, DOMAIN, WORKBOOK, {
				replace: true,
			}),
		).toEqual({
			success: false,
			status: 402,
			message: "Some rows were skipped",
			mayHaveLanded: true,
		});
	});

	it("says nothing landed when the refusal came from below the view", async () => {
		/* A 403 from the auth layer never reached `_upload_fixture_api`, so
		 * there is no verdict body and no message to keep. Reading one out
		 * of an edge's HTML would put a proxy's page in front of a person. */
		fetchMock.mockResolvedValue(new Response("nope", { status: 403 }));
		expect(
			await uploadLookupTableWorkbook(CREDS, DOMAIN, WORKBOOK, {
				replace: true,
			}),
		).toMatchObject({
			success: false,
			status: 403,
			message: "",
			mayHaveLanded: false,
		});
	});

	it("assumes tables landed when the view itself broke", async () => {
		/* `_run_upload` is not one transaction — only `flush` is `@atomic`,
		 * and `process_table` calls it mid-pass once a table has more than
		 * a thousand rows to write or delete. A 500 after that flush leaves
		 * real tables on the project space, and reading it as "nothing
		 * happened" would record nothing and make the next publish meet
		 * Nova's own tables as a stranger's. */
		fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
		expect(
			await uploadLookupTableWorkbook(CREDS, DOMAIN, WORKBOOK, {
				replace: true,
			}),
		).toMatchObject({ success: false, status: 500, mayHaveLanded: true });
	});

	it("assumes tables landed when the answer never came back", async () => {
		// The request went out. What CommCare HQ did with it is unknown.
		fetchMock.mockRejectedValue(new Error("socket hang up"));
		expect(
			await uploadLookupTableWorkbook(CREDS, DOMAIN, WORKBOOK, {
				replace: true,
			}),
		).toMatchObject({ success: false, status: 503, mayHaveLanded: true });
	});

	it("rejects a domain slug that is not one before any request goes out", async () => {
		expect(
			await uploadLookupTableWorkbook(CREDS, "not a slug", WORKBOOK, {
				replace: true,
			}),
		).toEqual({
			success: false,
			status: 400,
			message: "",
			mayHaveLanded: false,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
