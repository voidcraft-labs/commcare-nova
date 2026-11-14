/** The one JSON reader of CommCare HQ, against a controlled HTTP peer and HQ's retained answers. */
import type { MockAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	replyRetained,
	retainedBodyText,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { log } from "@/lib/logger";
import { HQ_REFUSED_BODY_MAX_CHARS } from "../hq/http";
import { readHqCollection } from "../hq/readCollection";
import { readHqJson } from "../hq/readJson";
import { HQ_READ_SENDS } from "../hq/throttle";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const APP = "/a/clinic/api/application/v1/working-app/";
const URL = HOST + APP;

afterEach(() => vi.useRealTimers());

function intercept(peer: MockAgent, path = APP) {
	return peer.get(HOST).intercept({ path, method: "GET" });
}

/** The retained throttle answer with the wait HQ's limiter would name. */
function throttledFor(seconds: string): RetainedHqAnswer {
	const answer = retainedReadingRead("list-apps-429");
	return { ...answer, headers: { ...answer.headers, "Retry-After": seconds } };
}

const calls = (peer: MockAgent) => peer.getCallHistory()?.calls() ?? [];

/**
 * Until the read's resend wait is scheduled beside its deadline. It yields
 * through `setImmediate`, which the fake clock leaves real, so no fake time
 * passes while it waits (`vi.waitFor` would advance the clock as it polls).
 */
async function untilWaitScheduled(): Promise<void> {
	while (vi.getTimerCount() < 2)
		await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("a 2xx answer Nova cannot use", () => {
	it("tells a body over the bound, a page for a browser and broken JSON apart, each a 502", async () => {
		await withHttpPeer(async (peer) => {
			intercept(peer).reply(200, JSON.stringify({ id: "x".repeat(64) }));
			intercept(peer).reply(200, "\n  <!DOCTYPE html><html>Sign in</html>");
			intercept(peer).reply(200, "{ not json");
			expect(
				await readHqJson(CREDS, URL, "application", { maxBytes: 32 }),
			).toEqual({ success: false, status: 502, cause: "too-large" });
			expect(await readHqJson(CREDS, URL, "application")).toEqual({
				success: false,
				status: 502,
				cause: "browser-page",
			});
			expect(await readHqJson(CREDS, URL, "application")).toEqual({
				success: false,
				status: 502,
				cause: "malformed",
			});
			expect(log.error).toHaveBeenCalledWith(
				"[commcare] application is longer than Nova reads",
				undefined,
				expect.objectContaining({ maxBytes: 32 }),
			);
		});
	});
});

describe("refusedBody", () => {
	it("is absent unless the read asks for it, and then holds HQ's own answer", async () => {
		const refusal = retainedReadingRead("application-no-api-access");
		await withHttpPeer(async (peer) => {
			replyRetained(intercept(peer), refusal);
			replyRetained(intercept(peer), refusal);
			expect(await readHqJson(CREDS, URL, "application")).toEqual({
				success: false,
				status: 401,
				edgeRefusal: false,
			});
			expect(
				await readHqJson(CREDS, URL, "application", { keepRefusedBody: true }),
			).toEqual({
				success: false,
				status: 401,
				edgeRefusal: false,
				refusedBody: retainedBodyText(refusal),
			});
		});
	});

	it("is cut at its character bound, from the one read that also tells the edge apart", async () => {
		const page = `<html><head><title>403 Forbidden</title></head><body>${"x".repeat(3_000)}</body></html>`;
		await withHttpPeer(async (peer) => {
			intercept(peer).reply(403, page);
			const error = await readHqJson(CREDS, URL, "application", {
				keepRefusedBody: true,
			});
			expect(error).toEqual({
				success: false,
				status: 403,
				edgeRefusal: true,
				refusedBody: page.slice(0, HQ_REFUSED_BODY_MAX_CHARS),
			});
			expect(log.warn).toHaveBeenCalledWith("[commcare] application refused", {
				status: 403,
				body: page.slice(0, 200),
			});
		});
	});
});

describe("a 429", () => {
	it.each([
		["application-429", "names no wait, so the read waits one second"],
		["list-apps-429", "names a second, which the read waits"],
	] as const)("%s %s and sends again", async (name, _why) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			replyRetained(intercept(peer), retainedReadingRead(name));
			intercept(peer).reply(200, { id: "working-app" });
			const pending = readHqJson(CREDS, URL, "application");
			await untilWaitScheduled();
			await vi.advanceTimersByTimeAsync(999);
			expect(calls(peer)).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(await pending).toEqual({ data: { id: "working-app" } });
			expect(calls(peer)).toHaveLength(2);
			expect(log.warn).toHaveBeenCalledWith(
				"[commcare] application rate limited, sending again",
				{ domain: "clinic", waitMs: 1_000, sent: 1 },
			);
		});
	});

	it("waits the two seconds a Retry-After names at the most", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			replyRetained(intercept(peer), throttledFor("2.0"));
			intercept(peer).reply(200, { id: "working-app" });
			const pending = readHqJson(CREDS, URL, "application");
			await untilWaitScheduled();
			await vi.advanceTimersByTimeAsync(1_999);
			expect(calls(peer)).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(await pending).toEqual({ data: { id: "working-app" } });
		});
	});

	it("is the answer at once where its Retry-After is past two seconds", async () => {
		await withHttpPeer(async (peer) => {
			replyRetained(intercept(peer), throttledFor("2.5"));
			expect(await readHqJson(CREDS, URL, "application")).toEqual({
				success: false,
				status: 429,
				edgeRefusal: false,
				retryAfterMs: 2_500,
			});
			expect(calls(peer)).toHaveLength(1);
		});
	});

	it("is the answer after the read has been sent three times", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			for (let i = 0; i < HQ_READ_SENDS; i++)
				replyRetained(intercept(peer), retainedReadingRead("application-429"));
			const pending = readHqJson(CREDS, URL, "application");
			for (let resend = 1; resend < HQ_READ_SENDS; resend++) {
				await untilWaitScheduled();
				await vi.advanceTimersByTimeAsync(1_000);
			}
			expect(await pending).toEqual({
				success: false,
				status: 429,
				edgeRefusal: false,
			});
			expect(calls(peer)).toHaveLength(HQ_READ_SENDS);
		});
	});

	it("is the answer where the wait would outlast a list read's deadline one second away", async () => {
		await withHttpPeer(async (peer) => {
			replyRetained(intercept(peer), throttledFor("2"));
			const controller = new AbortController();
			expect(
				await readHqJson(CREDS, URL, "application", {
					signal: controller.signal,
					deadline: Date.now() + 1_000,
				}),
			).toEqual({
				success: false,
				status: 429,
				edgeRefusal: false,
				retryAfterMs: 2_000,
			});
			expect(calls(peer)).toHaveLength(1);
		});
	});

	it("is the answer where the wait would outlast the reader's own deadline", async () => {
		await withHttpPeer(async (peer) => {
			replyRetained(intercept(peer), throttledFor("2"));
			expect(
				await readHqJson(CREDS, URL, "application", { deadlineMs: 1_500 }),
			).toEqual({
				success: false,
				status: 429,
				edgeRefusal: false,
				retryAfterMs: 2_000,
			});
			expect(calls(peer)).toHaveLength(1);
		});
	});
});

describe("deadlineMs and cancel", () => {
	/** A peer that holds its answer until the test releases it. */
	function held(peer: MockAgent, path = APP) {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		intercept(peer, path).reply(async () => {
			reached.resolve();
			await release.promise;
			return {
				statusCode: 200,
				data: JSON.stringify({ objects: [], meta: { next: null } }),
			};
		});
		return { reached: reached.promise, release: () => release.resolve() };
	}

	it("reads an answer that arrives at 45 seconds under a 60 second deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			const answer = held(peer);
			const pending = readHqJson(CREDS, URL, "application", {
				deadlineMs: 60_000,
			});
			try {
				await answer.reached;
				await vi.advanceTimersByTimeAsync(45_000);
				answer.release();
				expect(await pending).toEqual({
					data: { objects: [], meta: { next: null } },
				});
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				answer.release();
				await pending;
			}
		});
	});

	it("is a timeout at 60 seconds, and not before, where the peer never answers", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			const answer = held(peer);
			let settled = false;
			const pending = readHqJson(CREDS, URL, "application", {
				deadlineMs: 60_000,
			}).finally(() => {
				settled = true;
			});
			try {
				await answer.reached;
				await vi.advanceTimersByTimeAsync(59_999);
				expect(settled).toBe(false);
				await vi.advanceTimersByTimeAsync(1);
				expect(await pending).toEqual({
					success: false,
					status: 503,
					cause: "timeout",
				});
				expect(log.warn).toHaveBeenCalledWith(
					"[commcare] application unavailable",
					expect.anything(),
				);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				answer.release();
				await pending;
			}
		});
	});

	it("stops a held read when cancel aborts, as no answer, and logs nothing", async () => {
		await withHttpPeer(async (peer) => {
			const answer = held(peer);
			const cancel = new AbortController();
			const pending = readHqJson(CREDS, URL, "application", {
				cancel: cancel.signal,
			});
			try {
				await answer.reached;
				cancel.abort();
				expect(await pending).toEqual({
					success: false,
					status: 503,
					cause: "network",
				});
				expect(log.warn).not.toHaveBeenCalled();
				expect(log.error).not.toHaveBeenCalled();
			} finally {
				answer.release();
				await pending;
			}
		});
	});

	const LIST = "/a/clinic/api/lookup_table/v1/?limit=100";
	const NEXT = "/a/clinic/api/lookup_table/v1/?limit=100&offset=100";

	it.each(["whole", "page"] as const)(
		"sends a %s list read no further page once cancel aborts",
		async (deadline) => {
			await withHttpPeer(async (peer) => {
				intercept(peer, LIST).reply(200, {
					objects: [{ id: "one" }],
					meta: { next: NEXT },
				});
				const cancel = new AbortController();
				expect(
					await readHqCollection(CREDS, HOST + LIST, "lookup table list", 5, {
						deadline,
						cancel: cancel.signal,
						onMeta: () => cancel.abort(),
					}),
				).toEqual({ success: false, status: 503, cause: "network" });
				expect(calls(peer).map((call) => call.fullUrl)).toEqual([HOST + LIST]);
				expect(log.warn).not.toHaveBeenCalled();
			});
		},
	);

	it.each(["whole", "page"] as const)(
		"stops a %s list read's held page when cancel aborts, and logs nothing",
		async (deadline) => {
			await withHttpPeer(async (peer) => {
				const answer = held(peer, LIST);
				const cancel = new AbortController();
				const pending = readHqCollection(
					CREDS,
					HOST + LIST,
					"lookup table list",
					5,
					{ deadline, cancel: cancel.signal },
				);
				try {
					await answer.reached;
					cancel.abort();
					expect(await pending).toEqual({
						success: false,
						status: 503,
						cause: "network",
					});
					expect(log.warn).not.toHaveBeenCalled();
				} finally {
					answer.release();
					await pending;
				}
			});
		},
	);
});
