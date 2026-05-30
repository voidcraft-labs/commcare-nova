/**
 * Tests for the CommCare HQ multimedia upload client
 * (`lib/commcare/client.ts`).
 *
 * These assert the EXACT wire shape verified against
 * `commcare-hq/.../hqmedia/views.py` + `urls.py` — not a hand-rolled
 * echo of our own assumptions:
 *   - per-kind endpoint URL
 *     (`/a/{domain}/apps/{app_id}/multimedia/uploaded/{image|audio|video}/`),
 *   - multipart `Filedata` (bytes, filename = wire-path basename so the
 *     extension matches the `path`'s extension HQ's `validate_file`
 *     checks) + `path` (the full `jr://file/commcare/<hash><ext>`
 *     reference HQ records in `multimedia_map`),
 *   - `ApiKey {username}:{api_key}` + CSRF (`X-CSRFToken` / `Cookie` /
 *     `Referer`) headers,
 *   - response parse: HTTP 200 + `ref.m_id` = success;
 *     HTTP 400 + `errors[]` = typed error.
 *
 * `fetch` is stubbed via `vi.spyOn(globalThis, "fetch")` and restored
 * after each test so no real network call escapes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import { asAssetId, type MediaKind } from "@/lib/domain/multimedia";
import {
	type MediaUploadAsset,
	mediaUploadAssetsFromManifest,
	uploadAppMedia,
} from "../client";

const CREDS = { username: "user@example.org", apiKey: "abc123" };
const DOMAIN = "myproject";
const APP_ID = "app-uuid-1234";

/**
 * The CSRF login GET `fetchCsrfToken` makes before the batch. Returns a
 * `Set-Cookie: csrftoken=...` so the upload POSTs carry the token —
 * mirrors `importApp`'s CSRF flow. Returned for any URL ending in
 * `/accounts/login/`.
 */
function csrfLoginResponse(token: string): Response {
	const res = new Response(null, { status: 200 });
	res.headers.append("Set-Cookie", `csrftoken=${token}; Path=/`);
	return res;
}

/** A successful per-file upload response: HTTP 200 with `ref.m_id`. */
function uploadSuccessResponse(mId: string): Response {
	return new Response(
		JSON.stringify({
			ref: {
				path: "ignored",
				uid: "md5hash",
				m_id: mId,
				media_type: "Image",
			},
			errors: [],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

/** A rejected per-file upload: HTTP 400 (`HttpResponseBadRequest`) + errors. */
function uploadErrorResponse(message: string): Response {
	return new Response(JSON.stringify({ errors: [message] }), {
		status: 400,
		headers: { "Content-Type": "application/json" },
	});
}

function asset(
	wirePath: string,
	kind: MediaKind,
	bytes = "PNGDATA",
): MediaUploadAsset {
	return { wirePath, kind, bytes: Buffer.from(bytes) };
}

/**
 * Captured shape of one `fetch` call, normalized for assertions. Pulls
 * the multipart form fields out so tests can assert `path` + `Filedata`
 * filename without re-deriving FormData internals per test.
 */
interface CapturedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	pathField: string | null;
	fileName: string | null;
	fileBytes: string | null;
}

async function capture(
	mock: ReturnType<typeof vi.spyOn>,
): Promise<CapturedCall[]> {
	const calls: CapturedCall[] = [];
	for (const [input, init] of mock.mock.calls as Array<
		[RequestInfo | URL, RequestInit | undefined]
	>) {
		const url = String(input);
		// The CSRF login GET has no body — skip it; tests assert it
		// separately via the token threaded onto the upload headers.
		if (url.endsWith("/accounts/login/")) continue;
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const body = init?.body;
		let pathField: string | null = null;
		let fileName: string | null = null;
		let fileBytes: string | null = null;
		if (body instanceof FormData) {
			pathField = (body.get("path") as string | null) ?? null;
			const file = body.get("Filedata");
			if (file instanceof File) {
				fileName = file.name;
				fileBytes = await file.text();
			}
		}
		calls.push({
			url,
			method: init?.method ?? "GET",
			headers,
			pathField,
			fileName,
			fileBytes,
		});
	}
	return calls;
}

describe("uploadAppMedia", () => {
	let fetchMock: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchMock = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchMock.mockRestore();
	});

	it("posts one file per asset to the correct per-kind endpoint", async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/accounts/login/")) return csrfLoginResponse("tok");
			return uploadSuccessResponse("media-id-1");
		});

		const result = await uploadAppMedia(CREDS, DOMAIN, APP_ID, [
			asset("commcare/aaa.png", "image"),
			asset("commcare/bbb.mp3", "audio"),
			asset("commcare/ccc.mp4", "video"),
		]);

		expect(result).toEqual({ uploaded: 3, failures: [] });

		const calls = await capture(fetchMock);
		expect(calls).toHaveLength(3);

		// Exact per-kind URL — verified against hqmedia/urls.py
		// `uploaded/{image|audio|video}/` mounted under
		// app_manager's `^(?P<app_id>[\w-]+)/multimedia/`.
		expect(calls[0].url).toBe(
			`https://www.commcarehq.org/a/${DOMAIN}/apps/${APP_ID}/multimedia/uploaded/image/`,
		);
		expect(calls[1].url).toBe(
			`https://www.commcarehq.org/a/${DOMAIN}/apps/${APP_ID}/multimedia/uploaded/audio/`,
		);
		expect(calls[2].url).toBe(
			`https://www.commcarehq.org/a/${DOMAIN}/apps/${APP_ID}/multimedia/uploaded/video/`,
		);

		for (const call of calls) {
			expect(call.method).toBe("POST");
		}
	});

	it("sends `path` as the full jr:// reference and `Filedata` with the wire-path basename", async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/accounts/login/")) return csrfLoginResponse("tok");
			return uploadSuccessResponse("media-id-1");
		});

		await uploadAppMedia(CREDS, DOMAIN, APP_ID, [
			asset("commcare/deadbeef.png", "image", "RAWPNGBYTES"),
		]);

		const [call] = await capture(fetchMock);
		// `path` is the multimedia_map key HQ's create_mapping writes —
		// the full jr:// reference, NOT the bare wire path.
		expect(call.pathField).toBe("jr://file/commcare/deadbeef.png");
		// Filename = wire-path basename, so its extension matches the
		// path's extension (HQ validate_file requirement).
		expect(call.fileName).toBe("deadbeef.png");
		expect(call.fileBytes).toBe("RAWPNGBYTES");
	});

	it("sets the ApiKey Authorization and CSRF headers on each upload", async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/accounts/login/"))
				return csrfLoginResponse("csrf-token-xyz");
			return uploadSuccessResponse("media-id-1");
		});

		await uploadAppMedia(CREDS, DOMAIN, APP_ID, [
			asset("commcare/aaa.png", "image"),
		]);

		const [call] = await capture(fetchMock);
		expect(call.headers.Authorization).toBe(
			`ApiKey ${CREDS.username}:${CREDS.apiKey}`,
		);
		expect(call.headers["X-CSRFToken"]).toBe("csrf-token-xyz");
		expect(call.headers.Cookie).toBe("csrftoken=csrf-token-xyz");
		expect(call.headers.Referer).toBe(
			`https://www.commcarehq.org/a/${DOMAIN}/apps/${APP_ID}/multimedia/uploaded/image/`,
		);
	});

	it("fetches the CSRF token once and reuses it across every asset", async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/accounts/login/")) return csrfLoginResponse("tok");
			return uploadSuccessResponse("media-id-1");
		});

		await uploadAppMedia(CREDS, DOMAIN, APP_ID, [
			asset("commcare/aaa.png", "image"),
			asset("commcare/bbb.png", "image"),
		]);

		const loginCalls = (
			fetchMock.mock.calls as Array<[RequestInfo | URL, unknown]>
		).filter(([input]) => String(input).endsWith("/accounts/login/"));
		expect(loginCalls).toHaveLength(1);
	});

	it("records a per-asset failure (HTTP 400 + errors) without aborting the rest", async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/accounts/login/")) return csrfLoginResponse("tok");
			if (url.includes("/audio/"))
				return uploadErrorResponse("Not a valid audio file.");
			return uploadSuccessResponse("media-id-ok");
		});

		const result = await uploadAppMedia(CREDS, DOMAIN, APP_ID, [
			asset("commcare/aaa.png", "image"),
			asset("commcare/bbb.mp3", "audio"),
			asset("commcare/ccc.mp4", "video"),
		]);

		expect(result).toEqual({
			uploaded: 2,
			failures: [{ wirePath: "commcare/bbb.mp3", status: 400 }],
		});
	});

	it("records a thrown per-asset transport failure without aborting the rest", async () => {
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/accounts/login/")) return csrfLoginResponse("tok");
			if (url.includes("/audio/")) throw new Error("network down");
			return uploadSuccessResponse("media-id-ok");
		});

		const result = await uploadAppMedia(CREDS, DOMAIN, APP_ID, [
			asset("commcare/aaa.png", "image"),
			asset("commcare/bbb.mp3", "audio"),
			asset("commcare/ccc.mp4", "video"),
		]);

		expect(result).toEqual({
			uploaded: 2,
			failures: [{ wirePath: "commcare/bbb.mp3", status: 0 }],
		});
	});

	it("treats HTTP 200 with empty `ref` (no m_id) as a failure, not silent success", async () => {
		// A shape regression — 200 but no ref.m_id — would otherwise leave
		// a broken reference with zero signal. The client guards both
		// `errors` empty AND `ref.m_id` present.
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/accounts/login/")) return csrfLoginResponse("tok");
			return new Response(JSON.stringify({ ref: {}, errors: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const result = await uploadAppMedia(CREDS, DOMAIN, APP_ID, [
			asset("commcare/aaa.png", "image"),
		]);

		expect(result).toEqual({
			uploaded: 0,
			failures: [{ wirePath: "commcare/aaa.png", status: 422 }],
		});
	});

	it("is a no-op for a media-free app (no assets)", async () => {
		const result = await uploadAppMedia(CREDS, DOMAIN, APP_ID, []);
		expect(result).toEqual({ uploaded: 0, failures: [] });
		// No fetch at all — not even the CSRF login.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects an invalid domain slug before any network call", async () => {
		const result = await uploadAppMedia(CREDS, "../etc/passwd", APP_ID, [
			asset("commcare/aaa.png", "image"),
		]);
		expect(result).toEqual({ success: false, status: 400 });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("mediaUploadAssetsFromManifest", () => {
	it("projects every manifest entry to a wirePath/kind/bytes asset", () => {
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
					bytes: Buffer.from("PNG"),
				},
			],
			[
				asAssetId("id-2"),
				{
					assetId: asAssetId("id-2"),
					wirePath: "commcare/bbb.mp3",
					kind: "audio" as const,
					mimeType: "audio/mpeg",
					contentHash: "bbb",
					extension: ".mp3",
					bytes: Buffer.from("MP3"),
				},
			],
		]);

		const assets = mediaUploadAssetsFromManifest(manifest);
		expect(assets).toEqual([
			{
				wirePath: "commcare/aaa.png",
				kind: "image",
				bytes: Buffer.from("PNG"),
			},
			{
				wirePath: "commcare/bbb.mp3",
				kind: "audio",
				bytes: Buffer.from("MP3"),
			},
		]);
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
					// bytes intentionally absent — path-only manifest
				},
			],
		]);

		expect(() => mediaUploadAssetsFromManifest(manifest)).toThrow(
			/without loaded bytes/,
		);
	});

	it("collapses two asset ids that share one wire path into a single upload", () => {
		// The storage layer's ready-dedup probe ignores pending rows, so a
		// race can land two `ready` rows with the same (contentHash,
		// extension) — and thus one wire path. The compiler dedups these in
		// `buildMediaBundle`; the upload must too, so the POST count (and
		// the `uploaded` tally) matches the actual file count.
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
					bytes: Buffer.from("PNG"),
				},
			],
			[
				asAssetId("id-2"),
				{
					assetId: asAssetId("id-2"),
					wirePath: "commcare/aaa.png",
					kind: "image" as const,
					mimeType: "image/png",
					contentHash: "aaa",
					extension: ".png",
					bytes: Buffer.from("PNG"),
				},
			],
		]);

		const assets = mediaUploadAssetsFromManifest(manifest);
		expect(assets).toEqual([
			{
				wirePath: "commcare/aaa.png",
				kind: "image",
				bytes: Buffer.from("PNG"),
			},
		]);
	});
});
