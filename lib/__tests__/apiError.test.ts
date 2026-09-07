/** Native Request bodies exercise byte admission, stream ownership and HTTP error projection. */

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
	declaredBodyTooLarge,
	handleApiError,
	isClientAbort,
	parseApiErrorMessage,
	readJsonBody,
} from "../apiError";

function request(body?: BodyInit, headers?: HeadersInit): Request {
	return new Request("http://localhost/api/example", {
		method: "POST",
		body,
		headers,
		duplex: "half",
	} as RequestInit);
}

describe("readJsonBody", () => {
	it("decodes a valid Unicode body at its exact byte limit across split UTF-8 sequences", async () => {
		const bytes = new TextEncoder().encode('{"name":"é😀"}');
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
				controller.close();
			},
		});
		const req = request(stream);
		expect(await readJsonBody(req, bytes.length)).toEqual({ name: "é😀" });
		expect(req.bodyUsed).toBe(true);
		expect(req.body?.locked).toBe(false);
	});

	it("rejects a declared oversized body before reading its native stream", async () => {
		const req = request('{"a":1}', { "content-length": "5000" });
		try {
			await expect(readJsonBody(req, 4096)).rejects.toMatchObject({
				status: 413,
			});
			expect(req.bodyUsed).toBe(false);
			expect(req.body?.locked).toBe(false);
		} finally {
			await req.body?.cancel();
		}
	});

	it.each([undefined, { "content-length": "1" }])(
		"rejects actual excess bytes without waiting for an unfinished body (%j)",
		async (headers) => {
			let cancelled = false;
			let pulls = 0;
			const req = request(
				new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							pulls++;
							if (pulls === 1) controller.enqueue(new Uint8Array(9));
							else {
								controller.enqueue(new Uint8Array(100));
								controller.close();
							}
						},
						cancel() {
							cancelled = true;
						},
					},
					{ highWaterMark: 0 },
				),
				headers,
			);
			const result = readJsonBody(req, 8);
			await expect(result).rejects.toMatchObject({ status: 413 });
			expect(cancelled).toBe(true);
			expect(pulls).toBe(1);
			expect(req.body?.locked).toBe(false);
		},
	);

	it("preserves native stream errors and releases its reader", async () => {
		const failure = new DOMException("request aborted", "AbortError");
		const req = request(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(failure);
				},
			}),
		);
		await expect(readJsonBody(req, 20)).rejects.toBe(failure);
		expect(req.body?.locked).toBe(false);
	});

	it.each([undefined, "", "not json", '{"unfinished":'])(
		"returns null for absent or malformed JSON %j",
		async (body) => {
			expect(await readJsonBody(request(body), 4096)).toBeNull();
		},
	);
});

describe("declaredBodyTooLarge", () => {
	it.each([
		["5000", true],
		["4096", false],
		["4095", false],
		[undefined, false],
		["5000, 5000", true],
		["invalid", false],
	] as const)(
		"classifies declared length %j before acquiring a body",
		(length, expected) => {
			const req = request(
				undefined,
				length === undefined ? undefined : { "content-length": length },
			);
			expect(declaredBodyTooLarge(req, 4096)).toBe(expected);
		},
	);
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
		// A fault that merely MENTIONS an abort mid-message is a real server
		// error — a substring match here would 499 it out of Sentry's sight.
		expect(
			isClientAbort(new Error("transaction aborted due to contention")),
		).toBe(false);
		expect(isClientAbort(new Error("10 ABORTED: too much contention"))).toBe(
			false,
		);
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
		const body = await res.json();
		expect(body).toEqual({
			error:
				err instanceof ApiError
					? err.message
					: res.status === 499
						? "Client closed request"
						: res.status === 404
							? "App not found"
							: "Internal server error",
		});
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

describe("parseApiErrorMessage — both chat-transport error shapes", () => {
	it("extracts `error` from a bare JSON body (DefaultChatTransport shape)", () => {
		expect(
			parseApiErrorMessage(
				'{"error":"Out of credits","type":"out_of_credits"}',
			),
		).toBe("Out of credits");
	});

	it("extracts `error` from a prefixed body (WorkflowChatTransport shape)", () => {
		expect(
			parseApiErrorMessage(
				'Failed to fetch chat: 429 {"error":"Out of credits","type":"out_of_credits"}',
			),
		).toBe("Out of credits");
	});

	it("returns the raw string when no `error` field is recoverable", () => {
		expect(parseApiErrorMessage("network down")).toBe("network down");
		expect(parseApiErrorMessage('{"message":"nope"}')).toBe(
			'{"message":"nope"}',
		);
	});
});
