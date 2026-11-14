/**
 * The media file reader, against a peer the test writes whole: the reader
 * matches nothing of HQ's answer but a status and bytes, so no retained
 * answer is needed to hold it.
 *
 * An oversized file buffered, a sign-in page stored as an image, a request
 * built from an unchecked id and an outage reported as a missing file are
 * what these cases would catch.
 */

import type { MockAgent } from "undici";
import { afterEach, expect, it, vi } from "vitest";
import { withHttpPeer, withSocketHttpPeer } from "@/__tests__/helpers/httpPeer";
import { log } from "@/lib/logger";
import { readHqMediaFile } from "../hq/media";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const PATH = "/hq/multimedia/file/CommCareImage/abc123/";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(() => vi.useRealTimers());

const intercept = (peer: MockAgent) =>
	peer.get(HOST).intercept({
		path: PATH,
		method: "GET",
		headers: { authorization: "ApiKey account:key" },
	});
const calls = (peer: MockAgent) => peer.getCallHistory()?.calls() ?? [];
const read = (options: { maxBytes?: number; cancel?: AbortSignal } = {}) =>
	readHqMediaFile(CREDS, "CommCareImage", "abc123", {
		maxBytes: options.maxBytes ?? 1024,
		cancel: options.cancel,
	});

/** Until the resend's wait is scheduled beside the file's deadline. */
async function untilWaitScheduled(): Promise<void> {
	while (vi.getTimerCount() < 2)
		await new Promise<void>((resolve) => setImmediate(resolve));
}

it("returns a file's bytes with the type it declares, as a hint", async () => {
	await withHttpPeer(async (peer) => {
		intercept(peer).reply(200, Buffer.from(PNG), {
			headers: { "Content-Type": "Image/PNG; charset=binary" },
		});
		expect(await read()).toEqual({
			kind: "read",
			bytes: PNG,
			declaredContentType: "image/png",
		});
		expect(calls(peer).map((call) => call.headers)).toEqual([
			expect.objectContaining({ Accept: "*/*" }),
		]);
	});
});

it("is too large one byte over the bound, and cancels the body before the peer finishes it", async () => {
	const closed = Promise.withResolvers<void>();
	let peerEnded = false;
	let finish: ReturnType<typeof setTimeout> | undefined;
	await withSocketHttpPeer(
		"india.commcarehq.org",
		(_request, response) => {
			response.writeHead(200, { "content-type": "image/png" });
			response.once("close", closed.resolve);
			response.write(Buffer.alloc(1025));
			/* A broken reader is allowed to finish, so failure still owns teardown. */
			finish = setTimeout(() => {
				peerEnded = true;
				response.end();
			}, 1_000);
		},
		async () => {
			try {
				expect(await read({ maxBytes: 1024 })).toEqual({
					kind: "too-large",
					maxBytes: 1024,
				});
				expect(peerEnded).toBe(false);
				await closed.promise;
			} finally {
				clearTimeout(finish);
			}
		},
	);
});

it("reads a file exactly at the bound", async () => {
	await withHttpPeer(async (peer) => {
		intercept(peer).reply(200, Buffer.alloc(1024));
		const answer = await read({ maxBytes: 1024 });
		expect(answer).toMatchObject({ kind: "read", declaredContentType: null });
		expect("bytes" in answer && answer.bytes.byteLength).toBe(1024);
	});
});

it("is missing on HQ's 404, and the edge's 404 is no answer about the file", async () => {
	await withHttpPeer(async (peer) => {
		intercept(peer).reply(404, "", {
			headers: { "Content-Type": "text/html" },
		});
		expect(await read()).toEqual({ kind: "missing" });
		intercept(peer).reply(
			404,
			"<html><head><title>404 Not Found</title></head><body>nginx</body></html>",
		);
		expect(await read()).toEqual({
			success: false,
			status: 404,
			edgeRefusal: true,
		});
	});
});

it("reads a page for a browser in place of a file as browser-page", async () => {
	await withHttpPeer(async (peer) => {
		intercept(peer).reply(200, "<html><body>Sign in</body></html>", {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
		expect(await read()).toEqual({
			success: false,
			status: 502,
			cause: "browser-page",
		});
	});
});

it("asks once more after a second where HQ could not send the file, and no more", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	await withHttpPeer(async (peer) => {
		intercept(peer).reply(503, "");
		intercept(peer).reply(200, Buffer.from(PNG));
		const pending = read();
		await untilWaitScheduled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await pending).toEqual({
			kind: "read",
			bytes: PNG,
			declaredContentType: null,
		});
		expect(calls(peer)).toHaveLength(2);

		intercept(peer).reply(503, "");
		intercept(peer).reply(503, "");
		const twice = read();
		await untilWaitScheduled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await twice).toEqual({
			success: false,
			status: 503,
			edgeRefusal: false,
		});
		expect(calls(peer)).toHaveLength(4);
	});
});

it("sends a 500 once and answers it, logging its status and never its body", async () => {
	await withHttpPeer(async (peer) => {
		intercept(peer).reply(500, "Traceback: secret detail");
		expect(await read()).toEqual({
			success: false,
			status: 500,
			edgeRefusal: false,
		});
		expect(calls(peer)).toHaveLength(1);
	});
	expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
		"[commcare] media file refused",
		{ request: "media-file", status: 500 },
	);
	expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain(
		"secret detail",
	);
});

it("sends nothing for an id that is not one HQ gives", async () => {
	await withHttpPeer(async (peer) => {
		expect(
			await readHqMediaFile(CREDS, "CommCareImage", "abc/../123", {
				maxBytes: 1024,
			}),
		).toEqual({ success: false, status: 400 });
		expect(calls(peer)).toHaveLength(0);
	});
});

it("ends the read with nothing kept when cancel aborts mid-body", async () => {
	const reached = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const cancel = new AbortController();
	let pending: ReturnType<typeof read> | undefined;
	try {
		await withSocketHttpPeer(
			"india.commcarehq.org",
			(_request, response) => {
				response.writeHead(200, { "content-type": "image/png" });
				response.once("close", closed.resolve);
				response.write(Buffer.from(PNG), () => reached.resolve());
			},
			async () => {
				pending = read({ cancel: cancel.signal });
				await reached.promise;
				cancel.abort();
				expect(await pending).toEqual({
					success: false,
					status: 503,
					cause: "network",
				});
				await closed.promise;
			},
		);
	} finally {
		await pending;
	}
});
