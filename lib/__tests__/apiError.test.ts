/**
 * Tests for `readJsonBody` — the JSON body guard that rejects an oversized
 * request both before buffering (declared Content-Length) AND after (actual
 * byte length, so a headerless/chunked stream can't slip the cap).
 *
 * A minimal `Request`-shaped fake (just `headers.get` + `arrayBuffer`) keeps the
 * test focused on the size gates. The "rejected before buffering" assertion is
 * exact: the declared-413 case uses an `arrayBuffer` mock and asserts it was
 * never called, proving the oversized body was never materialized.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The logger's `error` mirrors to Sentry, so `handleApiError`'s "don't
// log.error a client abort" contract is asserted by spying on it. `warn` stays
// Cloud-Logging-only.
const { logErrorMock, logWarnMock } = vi.hoisted(() => ({
	logErrorMock: vi.fn(),
	logWarnMock: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
	log: { error: logErrorMock, warn: logWarnMock, info: vi.fn() },
}));

import {
	ApiError,
	BLUEPRINT_REQUEST_MAX_BYTES,
	CHAT_REQUEST_MAX_BYTES,
	CLIENT_ERROR_MAX_BYTES,
	declaredBodyTooLarge,
	handleApiError,
	isClientAbort,
	OAUTH_REVOKE_MAX_BYTES,
	readJsonBody,
} from "../apiError";

function fakeReq(opts: {
	contentLength?: string;
	body?: string;
	arrayBuffer?: () => Promise<ArrayBuffer>;
}): Request {
	const arrayBuffer =
		opts.arrayBuffer ??
		(async () =>
			new TextEncoder().encode(opts.body ?? "").buffer as ArrayBuffer);
	return {
		headers: {
			get: (key: string) =>
				key.toLowerCase() === "content-length"
					? (opts.contentLength ?? null)
					: null,
		},
		arrayBuffer,
	} as unknown as Request;
}

describe("readJsonBody", () => {
	it("parses a body within the cap", async () => {
		const parsed = await readJsonBody(
			fakeReq({ contentLength: "7", body: '{"a":1}' }),
			4096,
		);
		expect(parsed).toEqual({ a: 1 });
	});

	it("rejects an over-cap DECLARED body with 413, BEFORE buffering it", async () => {
		const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
		await expect(
			readJsonBody(fakeReq({ contentLength: "5000", arrayBuffer }), 4096),
		).rejects.toMatchObject({ status: 413 });
		// The whole point: the oversized body is never materialized.
		expect(arrayBuffer).not.toHaveBeenCalled();
	});

	it("rejects a chunked body whose ACTUAL bytes exceed the cap (no Content-Length)", async () => {
		// The bypass a Content-Length-only gate misses: a chunked request omits
		// the header, so only the post-buffer byte check can reject it.
		await expect(
			readJsonBody(fakeReq({ body: "x".repeat(5000) }), 4096),
		).rejects.toMatchObject({ status: 413 });
	});

	it("returns null for an unparseable body (caller's schema makes the message)", async () => {
		const parsed = await readJsonBody(
			fakeReq({ contentLength: "8", body: "not json" }),
			4096,
		);
		expect(parsed).toBeNull();
	});

	it("allows a chunked body UNDER the cap through to parse", async () => {
		const parsed = await readJsonBody(fakeReq({ body: '{"b":2}' }), 4096);
		expect(parsed).toEqual({ b: 2 });
	});
});

describe("declaredBodyTooLarge", () => {
	it("is true only when Content-Length exceeds the cap", () => {
		expect(declaredBodyTooLarge(fakeReq({ contentLength: "5000" }), 4096)).toBe(
			true,
		);
		expect(declaredBodyTooLarge(fakeReq({ contentLength: "4096" }), 4096)).toBe(
			false,
		);
		// Chunked (no Content-Length) can't be judged here — the post-buffer byte
		// check in `readJsonBody` is what actually bounds it.
		expect(declaredBodyTooLarge(fakeReq({}), 4096)).toBe(false);
	});
});

describe("isClientAbort", () => {
	it("recognizes every client-disconnect error shape", () => {
		// The shapes a browser disconnect surfaces as across Node / undici.
		expect(isClientAbort(new Error("aborted"))).toBe(true);
		expect(isClientAbort(new Error("request aborted by the client"))).toBe(
			true,
		);
		expect(
			isClientAbort(
				new DOMException("The operation was aborted.", "AbortError"),
			),
		).toBe(true);
		expect(
			isClientAbort(Object.assign(new Error("x"), { name: "AbortError" })),
		).toBe(true);
		expect(
			isClientAbort(Object.assign(new Error("x"), { code: "ABORT_ERR" })),
		).toBe(true);
		expect(
			isClientAbort(
				Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
			),
		).toBe(true);
	});

	it("does NOT match a genuine server error", () => {
		expect(isClientAbort(new Error("auth store unreachable"))).toBe(false);
		expect(isClientAbort(new ApiError("nope", 400))).toBe(false); // ApiError has its own path
		expect(isClientAbort(undefined)).toBe(false);
		expect(isClientAbort("aborted")).toBe(false); // a bare string is not an Error
	});
});

describe("handleApiError — client-abort vs genuine error", () => {
	beforeEach(() => {
		logErrorMock.mockReset();
		logWarnMock.mockReset();
	});

	/* Drive handleApiError and DRAIN the response body: these cases assert
	 * status + the log spies, never the body, so the `NextResponse.json` stream
	 * would otherwise leak an async resource (the async-leak gate flags it). */
	async function handled(err: ApiError | Error): Promise<Response> {
		const res = handleApiError(err);
		await res.text();
		return res;
	}

	it("a client abort → 499, WARN (Cloud-Logging-only), never log.error → Sentry", async () => {
		const res = await handled(new Error("aborted"));
		expect(res.status).toBe(499);
		// The single most common /stream event must never reach Sentry.
		expect(logErrorMock).not.toHaveBeenCalled();
		expect(logWarnMock).toHaveBeenCalledTimes(1);
	});

	it("an ECONNRESET disconnect → 499, no log.error", async () => {
		const err = Object.assign(new Error("read ECONNRESET"), {
			code: "ECONNRESET",
		});
		const res = await handled(err);
		expect(res.status).toBe(499);
		expect(logErrorMock).not.toHaveBeenCalled();
	});

	it("a GENUINE unhandled error still 500s AND log.errors (→ Sentry)", async () => {
		const res = await handled(new Error("auth store unreachable"));
		expect(res.status).toBe(500);
		expect(logErrorMock).toHaveBeenCalledTimes(1);
		expect(logWarnMock).not.toHaveBeenCalled();
	});

	it("an ApiError uses its own status and never logs (abort short-circuit doesn't swallow it)", async () => {
		const res = await handled(new ApiError("Bad request", 400));
		expect(res.status).toBe(400);
		expect(logErrorMock).not.toHaveBeenCalled();
		expect(logWarnMock).not.toHaveBeenCalled();
	});

	it("an AppAccessError still maps to 404 without logging", async () => {
		const err = Object.assign(new Error("not_member"), {
			name: "AppAccessError",
		});
		const res = await handled(err);
		expect(res.status).toBe(404);
		expect(logErrorMock).not.toHaveBeenCalled();
	});
});

describe("request-size budgets", () => {
	it("keep the public/auth caps tiny, blueprint above the 1 MiB doc limit, and all under the platform ceiling", () => {
		expect(CLIENT_ERROR_MAX_BYTES).toBeLessThanOrEqual(64 * 1024);
		expect(OAUTH_REVOKE_MAX_BYTES).toBeLessThanOrEqual(64 * 1024);
		// A blueprint is one ~1 MiB-bounded Firestore doc; the cap must clear it.
		expect(BLUEPRINT_REQUEST_MAX_BYTES).toBeGreaterThan(1024 * 1024);
		// Chat carries the blueprint PLUS bounded history, so it's the largest.
		expect(CHAT_REQUEST_MAX_BYTES).toBeGreaterThanOrEqual(
			BLUEPRINT_REQUEST_MAX_BYTES,
		);
		// Every cap stays well under Cloud Run's ~32 MB inbound limit.
		for (const cap of [
			CLIENT_ERROR_MAX_BYTES,
			OAUTH_REVOKE_MAX_BYTES,
			BLUEPRINT_REQUEST_MAX_BYTES,
			CHAT_REQUEST_MAX_BYTES,
		]) {
			expect(cap).toBeLessThan(32 * 1024 * 1024);
		}
	});
});
