/**
 * Tests for the CommCare HQ bulk-multimedia upload client
 * (`lib/commcare/client.ts::uploadAppMediaBundle`) and the bulk-ZIP builder
 * (`lib/commcare/multimedia/bulkUploadZip.ts`).
 *
 * The wire shape is verified against the HQ source (NOT a hand-rolled echo
 * of our assumptions):
 *   - the API-key-authed endpoint
 *     (`POST /a/{domain}/apps/api/{app_id}/multimedia/`, the same
 *     `@api_auth()` gate as `import_app_api` — the per-kind
 *     `multimedia/uploaded/{kind}/` endpoints are session-only and reject
 *     an API key),
 *   - the multipart `bulk_upload_file` field carrying the ZIP,
 *   - `ApiKey {username}:{api_key}` + CSRF (`X-CSRFToken` / `Cookie` /
 *     `Referer`) headers,
 *   - the async contract: POST → `{ success, processing_id }`, then a
 *     status poll → `{ complete, matched_count, unmatched_count, errors }`.
 *
 * `fetch` is stubbed via `vi.spyOn(globalThis, "fetch")` and restored
 * after each test so no real network call escapes.
 */

import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import { buildMediaBulkUploadZip } from "@/lib/commcare/multimedia/bulkUploadZip";
import { asAssetId } from "@/lib/domain/multimedia";
import { uploadAppMediaBundle } from "../client";

const CREDS = {
	username: "user@example.org",
	apiKey: "abc123",
	server: "production",
} as const;
const DOMAIN = "myproject";
const APP_ID = "app-uuid-1234";

/** A resolved manifest entry with bytes (the upload path's contract). */
function entry(
	id: string,
	wirePath: string,
	kind: "image" | "audio" | "video",
	bytes: string,
) {
	return [
		asAssetId(id),
		{
			assetId: asAssetId(id),
			wirePath,
			kind,
			mimeType: kind === "image" ? "image/png" : "audio/mpeg",
			contentHash: wirePath.split("/")[1]?.split(".")[0] ?? "h",
			extension: `.${wirePath.split(".").pop()}`,
			bytes: Buffer.from(bytes),
		},
	] as const;
}

describe("buildMediaBulkUploadZip", () => {
	it("builds one entry per wire path, byte-for-byte, at the bare wire path", () => {
		const manifest: AssetManifest = new Map([
			entry("id-1", "commcare/aaa.png", "image", "PNG"),
			entry("id-2", "commcare/bbb.mp3", "audio", "MP3"),
		]);

		const zip = new AdmZip(buildMediaBulkUploadZip(manifest));
		const entries = zip
			.getEntries()
			.map((e) => e.entryName)
			.sort();
		expect(entries).toEqual(["commcare/aaa.png", "commcare/bbb.mp3"]);
		expect(zip.getEntry("commcare/aaa.png")?.getData().toString()).toBe("PNG");
		expect(zip.getEntry("commcare/bbb.mp3")?.getData().toString()).toBe("MP3");
	});

	it("collapses two asset ids that share one wire path into a single entry", () => {
		// A storage dedup race can land two ready rows with the same
		// (contentHash, extension) — and so one wire path; the ZIP must carry
		// the file once, not a duplicate entry.
		const manifest: AssetManifest = new Map([
			entry("id-1", "commcare/aaa.png", "image", "PNG"),
			entry("id-2", "commcare/aaa.png", "image", "PNG"),
		]);

		const zip = new AdmZip(buildMediaBulkUploadZip(manifest));
		expect(zip.getEntries()).toHaveLength(1);
	});

	it("throws when a manifest entry is missing its bytes", () => {
		const manifest: AssetManifest = new Map([
			[
				asAssetId("id-1"),
				{
					assetId: asAssetId("id-1"),
					wirePath: "commcare/aaa.png",
					kind: "image" as const,
					mimeType: "image/png",
					contentHash: "aaa",
					extension: ".png",
					// bytes intentionally absent — a path-only manifest
				},
			],
		]);
		expect(() => buildMediaBulkUploadZip(manifest)).toThrow(/bytes/);
	});
});

/** The CSRF login GET `fetchCsrfToken` makes before the POST. */
function csrfLoginResponse(token: string): Response {
	const res = new Response(null, { status: 200 });
	res.headers.append("Set-Cookie", `csrftoken=${token}; Path=/`);
	return res;
}

const ZIP = Buffer.from("ZIPBYTES");

describe("uploadAppMediaBundle", () => {
	let fetchMock: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchMock = vi.spyOn(globalThis, "fetch");
	});
	afterEach(() => {
		fetchMock.mockRestore();
	});

	it("POSTs the ZIP to the api-key endpoint, then polls status to completion", async () => {
		fetchMock.mockImplementation(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/accounts/login/")) return csrfLoginResponse("tok");
				if (url.endsWith("/multimedia/") && init?.method === "POST") {
					return new Response(
						JSON.stringify({ success: true, processing_id: "proc-1" }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				// Status GET → complete with one matched file.
				return new Response(
					JSON.stringify({
						complete: true,
						matched_count: 1,
						unmatched_count: 0,
						errors: [],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		);

		const result = await uploadAppMediaBundle(CREDS, DOMAIN, APP_ID, ZIP);
		expect(result).toEqual({
			matched: 1,
			unmatched: 0,
			unmatchedFiles: [],
			errors: [],
			timedOut: false,
		});

		// The POST hit the api-key bulk endpoint (NOT the per-kind session one)
		// with the bulk_upload_file field + ApiKey + CSRF headers.
		const post = (
			fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit]>
		).find(
			([u, i]) => String(u).endsWith("/multimedia/") && i?.method === "POST",
		);
		expect(post).toBeDefined();
		const [postUrl, postInit] = post as [string, RequestInit];
		expect(postUrl).toBe(
			`https://www.commcarehq.org/a/${DOMAIN}/apps/api/${APP_ID}/multimedia/`,
		);
		const headers = postInit.headers as Record<string, string>;
		expect(headers.Authorization).toBe(
			`ApiKey ${CREDS.username}:${CREDS.apiKey}`,
		);
		expect(headers["X-CSRFToken"]).toBe("tok");
		expect(postInit.body).toBeInstanceOf(FormData);
		expect((postInit.body as FormData).get("bulk_upload_file")).toBeInstanceOf(
			Blob,
		);
	});

	it("surfaces unmatched files (path + reason) + errors from the status result", async () => {
		fetchMock.mockImplementation(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/accounts/login/")) return csrfLoginResponse("tok");
				if (url.endsWith("/multimedia/") && init?.method === "POST") {
					return new Response(
						JSON.stringify({ success: true, processing_id: "proc-1" }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				// HQ's status report carries the per-file detail (`unmatched_files`)
				// behind the `unmatched_count` — the upload route maps each path
				// back to the carrier it serves.
				return new Response(
					JSON.stringify({
						complete: true,
						matched_count: 2,
						unmatched_count: 1,
						unmatched_files: [
							{
								path: "commcare/abc.png",
								reason: "Did not match any Image paths in application.",
							},
						],
						errors: ["a file errored"],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		);

		const result = await uploadAppMediaBundle(CREDS, DOMAIN, APP_ID, ZIP);
		expect(result).toEqual({
			matched: 2,
			unmatched: 1,
			unmatchedFiles: [
				{
					path: "commcare/abc.png",
					reason: "Did not match any Image paths in application.",
				},
			],
			errors: ["a file errored"],
			timedOut: false,
		});
	});

	it("returns a typed error when HQ rejects the POST (non-2xx)", async () => {
		fetchMock.mockImplementation(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/accounts/login/")) return csrfLoginResponse("tok");
				if (init?.method === "POST") {
					return new Response("nope", { status: 403 });
				}
				return new Response(null, { status: 404 });
			},
		);

		const result = await uploadAppMediaBundle(CREDS, DOMAIN, APP_ID, ZIP);
		expect(result).toEqual({ success: false, status: 403 });
	});

	it("returns a 422 when the POST is 200 but success:false (or no processing_id)", async () => {
		fetchMock.mockImplementation(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/accounts/login/")) return csrfLoginResponse("tok");
				if (init?.method === "POST") {
					return new Response(
						JSON.stringify({ success: false, error: "ZIP file is corrupt" }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(null, { status: 404 });
			},
		);

		const result = await uploadAppMediaBundle(CREDS, DOMAIN, APP_ID, ZIP);
		expect(result).toEqual({ success: false, status: 422 });
	});

	it("rejects an invalid domain slug before any network call", async () => {
		const result = await uploadAppMediaBundle(
			CREDS,
			"../etc/passwd",
			APP_ID,
			ZIP,
		);
		expect(result).toEqual({ success: false, status: 400 });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
