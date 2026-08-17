/**
 * Fetch-level tests for the CommCare HQ app import client
 * (`lib/commcare/client.ts::importApp`).
 *
 * The wire shape is verified against the HQ source
 * (`app_manager/views/app_import_api.py::_handle_import_app`, NOT a
 * hand-rolled echo of our assumptions):
 *   - `POST /a/{domain}/apps/api/import_app/`, multipart `app_name` +
 *     `app_file`, with `ApiKey {username}:{api_key}` as the sole auth header
 *     (the endpoint is `@csrf_exempt` + `@waf_allow('XSS_BODY')`, so no CSRF
 *     token dance and no padding field),
 *   - create (no `app_id` field) → 201 `{ success, app_id }`, no version,
 *   - update (`app_id` field) → 200 `{ success, app_id, version }`,
 *   - unknown `app_id` → 404 `{ success: false, error }`,
 *   - HTTP 200 with `success: false` → application-level rejection.
 *
 * `fetch` is stubbed via `vi.spyOn(globalThis, "fetch")` and restored
 * after each test so no real network call escapes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importApp } from "../client";

const CREDS = {
	username: "user@example.org",
	apiKey: "abc123",
	server: "production",
} as const;
const DOMAIN = "myproject";
const APP_JSON = { doc_type: "Application", name: "Household Survey" };

describe("importApp", () => {
	let fetchMock: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchMock = vi.spyOn(globalThis, "fetch");
	});
	afterEach(() => {
		fetchMock.mockRestore();
	});

	function lastPost(): [string, RequestInit] {
		const call = fetchMock.mock.calls.at(-1) as [
			RequestInfo | URL,
			RequestInit,
		];
		return [String(call[0]), call[1]];
	}

	it("creates: POSTs app_name + app_file only, and returns the new app id with no version", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ success: true, app_id: "new-app-1" }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const result = await importApp(CREDS, DOMAIN, "Household Survey", APP_JSON);
		expect(result).toEqual({
			success: true,
			appId: "new-app-1",
			version: null,
			warnings: [],
		});

		const [url, init] = lastPost();
		expect(url).toBe(
			`https://www.commcarehq.org/a/${DOMAIN}/apps/api/import_app/`,
		);
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(
			`ApiKey ${CREDS.username}:${CREDS.apiKey}`,
		);
		// The endpoint is @csrf_exempt + @waf_allow('XSS_BODY'): the ApiKey
		// header is the only header and the form carries exactly the two
		// documented fields — no CSRF token, no padding field, no app_id.
		expect(headers["X-CSRFToken"]).toBeUndefined();
		expect(headers.Cookie).toBeUndefined();
		const body = init.body as FormData;
		expect(body).toBeInstanceOf(FormData);
		expect([...body.keys()]).toEqual(["app_name", "app_file"]);
		expect(body.get("app_name")).toBe("Household Survey");
		const file = body.get("app_file") as Blob;
		expect(await file.text()).toBe(JSON.stringify(APP_JSON));
	});

	it("updates: sends the app_id field and parses the resulting version", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({ success: true, app_id: "hq-app-9", version: 7 }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const result = await importApp(
			CREDS,
			DOMAIN,
			"Household Survey",
			APP_JSON,
			"hq-app-9",
		);
		expect(result).toEqual({
			success: true,
			appId: "hq-app-9",
			version: 7,
			warnings: [],
		});

		const body = lastPost()[1].body as FormData;
		expect([...body.keys()]).toEqual(["app_name", "app_id", "app_file"]);
		// app_name rides on updates too — HQ applies it after the merge, so
		// the HQ app's name tracks Nova's.
		expect(body.get("app_name")).toBe("Household Survey");
		expect(body.get("app_id")).toBe("hq-app-9");
	});

	it("passes HQ's import warnings through", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					app_id: "new-app-1",
					warnings: ["Unknown multimedia path"],
				}),
				{ status: 201, headers: { "Content-Type": "application/json" } },
			),
		);

		const result = await importApp(CREDS, DOMAIN, "Household Survey", APP_JSON);
		expect(result).toEqual({
			success: true,
			appId: "new-app-1",
			version: null,
			warnings: ["Unknown multimedia path"],
		});
	});

	it("passes a 404 through when the update target is gone from HQ", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({ success: false, error: "Application not found" }),
				{ status: 404, headers: { "Content-Type": "application/json" } },
			),
		);

		const result = await importApp(
			CREDS,
			DOMAIN,
			"Household Survey",
			APP_JSON,
			"deleted-app",
		);
		expect(result).toEqual({ success: false, status: 404 });
	});

	it("returns a 422 when HQ answers 200 with success:false", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ success: false }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const result = await importApp(CREDS, DOMAIN, "Household Survey", APP_JSON);
		expect(result).toEqual({ success: false, status: 422 });
	});

	it("rejects an invalid domain slug before any network call", async () => {
		const result = await importApp(
			CREDS,
			"../etc/passwd",
			"Household Survey",
			APP_JSON,
		);
		expect(result).toEqual({ success: false, status: 400 });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
