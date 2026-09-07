/**
 * The resumable chat-stream route against a real Postgres testcontainer:
 * the server half of the WorkflowChatTransport contract, driven end-to-end
 * through the REAL chunk log + LISTEN/NOTIFY.
 *
 * What this pins:
 *
 *   - Replay from a cursor: seeded chunk rows come back as `data:` frames in
 *     index order, mid-batch cursors slice within a row, and a terminal row
 *     ends the response with `data: [DONE]` + a close (never an open tail).
 *   - Negative `startIndex` resolves from the stream's end and the absolute
 *     tail rides back in `x-workflow-stream-tail-index` (the transport's
 *     retry math; Nova's own cold resume replays from 0 and windows
 *     client-side instead).
 *   - LIVE tail: chunks appended AFTER the stream opened arrive via the
 *     `nova_chat_stream` poke: end-to-end NOTIFY delivery.
 *   - The `DurableStreamWriter` → route round trip: what the chat POST's
 *     writer logs is exactly what a resume replays, synthetic finish
 *     included.
 *   - Dead-run fallback: a terminal-less stream whose app is held by NO live
 *     run closes with ONE synthetic `finish` after consecutive cadence
 *     ticks; a stream whose app IS held live keeps tailing.
 *   - Connect-time posture: an unknown stream and a scope denial are both
 *     404 (IDOR-safe).
 *   - Confirmed-only revocation: an `AppAccessError` on the cadence closes
 *     the stream; a transient scope throw leaves it open.
 *   - Thread resolution: a THREAD id resolves through its row's
 *     `active_stream_id` to the live stream (the cold page-refresh resume);
 *     a thread with nothing in flight answers a bare `finish`; a foreign
 *     thread is 404.
 *
 * Only session extraction is controlled. Project membership, active-user
 * checks, scope resolution, migrated tables, and LISTEN/NOTIFY are real.
 */

import type { UIMessageStreamWriter } from "ai";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import * as targetScope from "@/lib/db/generationTargetScope";
import type { AppDatabase } from "@/lib/db/pg";
import * as streamListener from "@/lib/db/streamListener";

const { requireSessionMock, getSessionSafeMock } = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	getSessionSafeMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({
	requireSession: requireSessionMock,
	getSessionSafe: getSessionSafeMock,
}));
const previousCadence = process.env.NOVA_CHAT_STREAM_CADENCE_MS;
process.env.NOVA_CHAT_STREAM_CADENCE_MS = "150";
const { GET } = await (async () => {
	try {
		return await import("../route");
	} finally {
		if (previousCadence === undefined)
			delete process.env.NOVA_CHAT_STREAM_CADENCE_MS;
		else process.env.NOVA_CHAT_STREAM_CADENCE_MS = previousCadence;
	}
})();
const { appendStreamChunks, pruneChatStreamChunks } = await import(
	"@/lib/db/streamChunks"
);
const { DurableStreamWriter } = await import("@/lib/chat/durableStreamWriter");
const { holderNonceReplayDigest, PRIVATE_HOLDER_NONCE_CHUNK_TYPE } =
	await import("@/lib/chat/privateHolderNonce");
const { __setListenerConfigForTests, closeStreamListener } = await import(
	"@/lib/db/streamListener"
);
const { claimAndReserveRun } = await import("@/lib/db/apps");
const { createExplicitBlankApp } = await import("@/lib/db/appGenesis");
const { persistResponseSnapshot, upsertThreadTurn } = await import(
	"@/lib/db/threads"
);

const USER = "user-1";
const PEER = "user-2";
const PROJECT = "project-1";
const SUCCESSOR_NONCE = "00000000-0000-4000-8000-000000000099";

const h = setupAppStateTestDb("chat_stream_", {
	authSchema: "migrated",
	poolMax: 4,
});
let appDb: Kysely<AppDatabase>;

async function holderNonceFor(appId: string): Promise<string> {
	const row = await appDb
		.selectFrom("apps")
		.select("run_holder_nonce")
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	if (!row.run_holder_nonce) throw new Error("fixture app has no holder nonce");
	return row.run_holder_nonce;
}

function sessionFor(userId: string) {
	return { user: { id: userId } };
}

/** Seed one chunk-log row directly (bypassing the writer, no poke). */
async function seedRow(
	streamId: string,
	firstIndex: number,
	chunks: unknown[],
	opts: { appId?: string; terminal?: boolean; createdAt?: Date } = {},
): Promise<void> {
	await appDb
		.insertInto("chat_stream_chunks")
		.values({
			stream_id: streamId,
			app_id: opts.appId ?? "app-1",
			run_id: "run-1",
			first_index: firstIndex,
			chunks: JSON.stringify(chunks),
			terminal: opts.terminal ?? false,
			...(opts.createdAt ? { created_at: opts.createdAt } : {}),
		})
		.execute();
}

const delta = (i: number) => ({
	type: "text-delta" as const,
	id: "0",
	delta: `c${i}`,
});

/** One parsed frame: a chunk object, or the literal "[DONE]" sentinel. */
type Frame = unknown | "[DONE]";

function parseFrames(raw: string): Frame[] {
	const frames: Frame[] = [];
	for (const block of raw.split("\n\n")) {
		const line = block.trim();
		if (!line.startsWith("data: ")) continue;
		const payload = line.slice(6);
		frames.push(payload === "[DONE]" ? "[DONE]" : JSON.parse(payload));
	}
	return frames;
}

/**
 * Open the resume stream and collect frames until the SERVER closes it (or
 * the deadline aborts). Every route outcome under test ends in a server-side
 * teardown, so `ended` distinguishes a real close from the deadline abort.
 * The deadline aborts `req.signal` so the pending read resolves `done`:
 * never a read raced against a timer.
 */
async function collectUntil(
	streamId: string,
	opts: {
		startIndex?: number;
		timeoutMs?: number;
		onOpen?: () => Promise<void> | void;
		userId?: string;
	},
): Promise<{ frames: Frame[]; response: Response; ended: boolean }> {
	const controller = new AbortController();
	const url = new URL(`http://localhost/api/chat/${streamId}/stream`);
	if (opts.startIndex !== undefined)
		url.searchParams.set("startIndex", String(opts.startIndex));
	const req = new Request(url, { signal: controller.signal });

	const userId = opts.userId ?? USER;
	requireSessionMock.mockResolvedValue(sessionFor(userId));
	getSessionSafeMock.mockResolvedValue(sessionFor(userId));

	const response = await GET(req, {
		params: Promise.resolve({ streamId }),
	});
	if (!response.ok || !response.body) {
		throw new Error(`non-OK stream open: ${response.status}`);
	}
	const reader = response.body.getReader();

	const decoder = new TextDecoder();
	let raw = "";
	const frames: Frame[] = [];
	/** True when the SERVER ended the stream (vs the deadline abort). */
	let ended = false;
	const timeoutMs = opts.timeoutMs ?? 4_000;
	let timedOut = false;
	const deadline = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	let opened: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
	const startProducer = () => {
		if (opened || !opts.onOpen) return;
		opened = Promise.resolve()
			.then(opts.onOpen)
			.then(
				() => ({ ok: true as const }),
				(error) => {
					controller.abort();
					return { ok: false as const, error };
				},
			);
	};

	let producerOutcome: Awaited<typeof opened>;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.value) {
				raw += decoder.decode(chunk.value, { stream: true });
				frames.length = 0;
				frames.push(...parseFrames(raw));
				if (frames.length > 0) startProducer();
			}
			if (chunk.done) {
				ended = !timedOut;
				break;
			}
		}
	} finally {
		clearTimeout(deadline);
		controller.abort();
		try {
			await reader.cancel();
		} finally {
			reader.releaseLock();
			producerOutcome = await opened;
		}
	}
	if (producerOutcome && !producerOutcome.ok) throw producerOutcome.error;
	return { frames, response, ended };
}

beforeEach(async () => {
	appDb = h.db();
	__setListenerConfigForTests(h.uri());
	await h.seedProjectMember(USER, PROJECT, "editor");
	await h.seedProjectMember(PEER, PROJECT, "editor");
	await h.seedApp({
		id: "app-1",
		owner: USER,
		project_id: PROJECT,
		status: "complete",
	});
	requireSessionMock.mockReset();
	getSessionSafeMock.mockReset();
	getSessionSafeMock.mockResolvedValue(sessionFor(USER));
});
afterEach(async () => {
	await closeStreamListener();
	__setListenerConfigForTests(null);
	vi.restoreAllMocks();
});
async function removeMembership() {
	await h
		.pool()
		.query(
			'DELETE FROM auth_member WHERE "userId" = $1 AND "organizationId" = $2',
			[USER, PROJECT],
		);
}

describe("replay", () => {
	it("replays seeded chunks in order and closes on the terminal row", async () => {
		await seedRow("s1", 0, [delta(0), delta(1)]);
		await seedRow("s1", 2, [delta(2), { type: "finish" }], { terminal: true });

		const { frames, ended } = await collectUntil("s1", {});
		expect(frames).toEqual([
			delta(0),
			delta(1),
			delta(2),
			{ type: "finish" },
			"[DONE]",
		]);
		expect(ended).toBe(true);
	});

	it("slices a mid-batch cursor within a row", async () => {
		await seedRow("s2", 0, [delta(0), delta(1), delta(2)]);
		await seedRow("s2", 3, [delta(3), { type: "finish" }], { terminal: true });

		const { frames } = await collectUntil("s2", {
			startIndex: 2,
		});
		expect(frames).toEqual([delta(2), delta(3), { type: "finish" }, "[DONE]"]);
	});

	it("seals a replay whose cursor sits past the log's own finish with a synthetic finish", async () => {
		// The wire/log skew shape: an error chunk enqueued on the raw response
		// (bypassing the durable writer) leaves the client's count past the
		// sealed log. Without a finish chunk on THIS response the transport
		// reconnects forever with zero backoff.
		await seedRow("s12", 0, [delta(0), { type: "finish" }], {
			terminal: true,
		});

		const { frames, ended } = await collectUntil("s12", {
			startIndex: 5,
			timeoutMs: 3_000,
		});
		expect(frames).toEqual([{ type: "finish" }, "[DONE]"]);
		expect(ended).toBe(true);
	});

	it("resolves a negative startIndex from the end and returns the tail header", async () => {
		/* The transport's stock tail contract — Nova's own client cold-resumes
		 * with `startIndex=0` and windows client-side, so this arm just stays
		 * faithful to the third-party protocol. */
		await seedRow("s3", 0, [delta(0), delta(1), delta(2)]);
		await seedRow("s3", 3, [delta(3), { type: "finish" }], { terminal: true });

		const { frames, response } = await collectUntil("s3", {
			startIndex: -2,
		});
		expect(frames).toEqual([delta(3), { type: "finish" }, "[DONE]"]);
		// 5 chunks total → tail index 4 (the transport computes
		// `tail + 1 + startIndex` for its retry cursor).
		expect(response.headers.get("x-workflow-stream-tail-index")).toBe("4");
		expect(response.headers.get("x-workflow-run-id")).toBe("s3");
	});
});

describe("live tail", () => {
	it("delivers chunks appended after connect via the NOTIFY poke", async () => {
		await seedRow("s4", 0, [delta(0)]);
		let listenerReady = false;
		const stopProbe = streamListener.subscribeChatStream("probe", () => {
			listenerReady = true;
		});
		try {
			await expect.poll(() => listenerReady).toBe(true);
		} finally {
			stopProbe();
		}
		let notificationPokes = 0;
		const subscribe = streamListener.subscribeChatStream;
		vi.spyOn(streamListener, "subscribeChatStream").mockImplementation(
			(id, poke) =>
				subscribe(id, () => {
					notificationPokes++;
					poke();
				}),
		);

		const { frames, ended } = await collectUntil("s4", {
			onOpen: async () => {
				// The real append path: INSERT + pg_notify on the per-test DB.
				await appendStreamChunks({
					streamId: "s4",
					target: { kind: "app", appId: "app-1" },
					runId: "run-1",
					firstIndex: 1,
					chunks: [delta(1), { type: "finish" }],
					terminal: true,
				});
			},
		});
		expect(frames).toEqual([delta(0), delta(1), { type: "finish" }, "[DONE]"]);
		expect(ended).toBe(true);
		expect(notificationPokes).toBeGreaterThan(0);
	});

	it("round-trips the DurableStreamWriter's log, synthetic finish included", async () => {
		const inner: UIMessageStreamWriter = {
			write() {},
			merge() {},
			onError: undefined,
		};
		const writer = new DurableStreamWriter({
			streamId: "s5",
			target: { kind: "app", appId: "app-1" },
			runId: "run-1",
			threadId: "thread-1",
			inner,
		});
		try {
			writer.write({
				type: "data-run-id",
				data: { runId: "run-1" },
				transient: true,
			});
			writer.write(delta(0));
			// No explicit finish: an error-terminated POST; close() synthesizes it.
		} finally {
			await writer.close();
		}

		const { frames } = await collectUntil("s5", {});
		expect(frames).toEqual([
			{ type: "data-run-id", data: { runId: "run-1" }, transient: true },
			delta(0),
			{ type: "finish" },
			"[DONE]",
		]);
	});

	it("rehydrates a private holder marker only for its actor and preserves the cursor for peers", async () => {
		const { appId } = await createExplicitBlankApp(
			USER,
			PROJECT,
			"run-private",
			{ status: "generating" },
		);
		const app = await appDb
			.selectFrom("apps")
			.select("run_holder_nonce")
			.where("id", "=", appId)
			.executeTakeFirstOrThrow();
		const holderNonce = app.run_holder_nonce;
		if (!holderNonce) {
			throw new Error("createApp did not mint a run holder nonce");
		}
		await upsertThreadTurn({
			target: { kind: "app", appId },
			threadId: "thread-private",
			runId: "run-private",
			streamId: "s-private",
			holderNonce,
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
			expectedProjectId: PROJECT,
		});
		const inner: UIMessageStreamWriter = {
			write() {},
			merge() {},
			onError: undefined,
		};
		const writer = new DurableStreamWriter({
			streamId: "s-private",
			target: { kind: "app", appId },
			runId: "run-private",
			threadId: "thread-private",
			inner,
		});
		try {
			writer.writePrivateHolderNonce(holderNonce);
		} finally {
			await writer.close();
		}
		/* Paused finalization clears the live stream marker but deliberately
		 * retains the nonce for the answer POST. A direct hot reconnect to the
		 * completed stream must still rehydrate this exact generation. */
		await appDb.transaction().execute(async (tx) => {
			await tx
				.updateTable("apps")
				.set({ awaiting_input: true })
				.where("id", "=", appId)
				.execute();
		});
		await persistResponseSnapshot({
			target: { kind: "app", appId },
			threadId: "thread-private",
			streamId: "s-private",
			expectedProjectId: PROJECT,
			clearMarker: true,
			responseMessage: null,
			retainHolderNonce: true,
		});

		const stored = await appDb
			.selectFrom("chat_stream_chunks")
			.select("chunks")
			.where("stream_id", "=", "s-private")
			.execute();
		expect(JSON.stringify(stored)).not.toContain(holderNonce);

		const owner = await collectUntil("s-private", {});
		expect(owner.frames).toEqual([
			{
				type: "data-holder-nonce",
				data: { holderNonce },
				transient: true,
			},
			{ type: "finish" },
			"[DONE]",
		]);

		const peer = await collectUntil("s-private", { userId: PEER });
		expect(peer.frames).toEqual([
			{
				type: PRIVATE_HOLDER_NONCE_CHUNK_TYPE,
				data: {
					threadId: "thread-private",
					holderDigest: holderNonceReplayDigest(holderNonce),
				},
				transient: true,
			},
			{ type: "finish" },
			"[DONE]",
		]);
		expect(peer.frames).toHaveLength(owner.frames.length);

		/* A later claim may deliberately reuse stable thread/run attribution.
		 * Its fresh nonce must not be projected while replaying the old stream. */
		await claimAndReserveRun(
			appId,
			"build",
			"run-private",
			USER,
			100,
			PROJECT,
			SUCCESSOR_NONCE,
		);
		await upsertThreadTurn({
			target: { kind: "app", appId },
			threadId: "thread-private",
			runId: "run-private",
			streamId: "s-successor",
			holderNonce: SUCCESSOR_NONCE,
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
			expectedProjectId: PROJECT,
		});
		const staleOwner = await collectUntil("s-private", {});
		expect(staleOwner.frames[0]).toEqual({
			type: PRIVATE_HOLDER_NONCE_CHUNK_TYPE,
			data: {
				threadId: "thread-private",
				holderDigest: holderNonceReplayDigest(holderNonce),
			},
			transient: true,
		});
	});
});

describe("dead-run fallback", () => {
	it("closes a terminal-less tail with one synthetic finish once nothing holds the app live", async () => {
		// An authorized, completed app has no live run holder.
		await seedRow("s6", 0, [delta(0)]);

		const { frames, ended } = await collectUntil("s6", {
			timeoutMs: 3_000,
		});
		expect(frames).toEqual([delta(0), { type: "finish" }, "[DONE]"]);
		expect(ended).toBe(true);
	});

	it("keeps tailing while the app is held live", async () => {
		// A real `generating` app row with a fresh `updated_at` → lease live.
		const { appId } = await createExplicitBlankApp(USER, PROJECT, "run-live", {
			status: "generating",
		});
		await seedRow("s7", 0, [delta(0)], { appId });
		let liveTicks = 0;
		const realHeldLive = targetScope.generationTargetHeldLive;
		vi.spyOn(targetScope, "generationTargetHeldLive").mockImplementation(
			async (...args) => {
				const live = await realHeldLive(...args);
				if (live) liveTicks++;
				return live;
			},
		);

		const { frames } = await collectUntil("s7", {
			// Several cadence ticks pass before the terminal lands; the fallback
			// must not fire in between (deadTicks resets while live).
			onOpen: async () => {
				await expect
					.poll(() => liveTicks, { timeout: 3000 })
					.toBeGreaterThanOrEqual(3);
				await appendStreamChunks({
					streamId: "s7",
					target: { kind: "app", appId },
					runId: "run-live",
					firstIndex: 1,
					chunks: [delta(1), { type: "finish" }],
					terminal: true,
				});
			},
			timeoutMs: 5_000,
		});
		// Exactly one finish: the appended one, no premature synthetic.
		expect(frames).toEqual([delta(0), delta(1), { type: "finish" }, "[DONE]"]);
	});
});

describe("auth posture", () => {
	it("404s an unknown stream", async () => {
		requireSessionMock.mockResolvedValue(sessionFor(USER));
		const res = await GET(
			new Request("http://localhost/api/chat/nope/stream"),
			{ params: Promise.resolve({ streamId: "nope" }) },
		);
		expect(res.status).toBe(404);
		// Drain the JSON body: an unread `NextResponse.json` stream is an
		// async resource the leak gate flags.
		await res.text();
	});

	it("404s a scope denial identically to a missing stream", async () => {
		await seedRow("s8", 0, [delta(0)]);
		await removeMembership();
		requireSessionMock.mockResolvedValue(sessionFor(USER));
		const res = await GET(new Request("http://localhost/api/chat/s8/stream"), {
			params: Promise.resolve({ streamId: "s8" }),
		});
		expect(res.status).toBe(404);
		await res.text();
	});

	it("closes on a CONFIRMED mid-stream membership loss, not on a transient throw", async () => {
		const { appId } = await createExplicitBlankApp(
			USER,
			PROJECT,
			"run-revoke",
			{ status: "generating" },
		);
		await seedRow("s9", 0, [delta(0)], { appId });

		const realScope = targetScope.resolveGenerationTargetScope;
		let cadenceCalls = 0;
		vi.spyOn(targetScope, "resolveGenerationTargetScope").mockImplementation(
			async (...args) => {
				cadenceCalls++;
				if (cadenceCalls === 2) throw new Error("pool exhausted");
				if (cadenceCalls === 3) await removeMembership();
				return realScope(...args);
			},
		);

		const { frames, ended } = await collectUntil("s9", {
			timeoutMs: 3_000,
		});
		// Closed WITHOUT [DONE]: a revoked tail is not a completed stream.
		expect(ended).toBe(true);
		expect(frames).toEqual([delta(0)]);
		expect(cadenceCalls).toBe(3);
	});
	it.each(["ban", "identity change"] as const)(
		"closes an active tail on confirmed %s without claiming completion",
		async (reason) => {
			await seedRow("revoked", 0, [delta(0)]);
			const { frames, ended } = await collectUntil("revoked", {
				onOpen: async () => {
					if (reason === "ban")
						await h
							.pool()
							.query("UPDATE auth_user SET banned = true WHERE id = $1", [
								USER,
							]);
					else getSessionSafeMock.mockResolvedValue(sessionFor(PEER));
				},
			});
			expect(ended).toBe(true);
			expect(frames).toEqual([delta(0)]);
		},
	);
});

describe("append idempotency", () => {
	it("converges a retried append of the same (stream, firstIndex) batch instead of raising", async () => {
		// The writer's in-chain retry can re-send a batch whose INSERT actually
		// committed (lost ack, or a failed advisory poke on the first call):
		// the duplicate must be a no-op, not a PK violation that marks the
		// stream broken.
		const batch = {
			streamId: "s13",
			target: { kind: "app" as const, appId: "app-1" },
			runId: "run-1",
			firstIndex: 0,
			chunks: [delta(0), { type: "finish" }],
			terminal: true,
		};
		await appendStreamChunks(batch);
		await expect(appendStreamChunks(batch)).resolves.toBeUndefined();

		const { frames } = await collectUntil("s13", {});
		expect(frames).toEqual([delta(0), { type: "finish" }, "[DONE]"]);
	});
});

describe("thread resolution", () => {
	/* The cold page-refresh resume: the GET's id is a THREAD id (the Chat
	 * instance's id), resolved through the thread row's `active_stream_id`
	 * to the live POST's chunk log. */
	it("resolves a thread id to its live stream and replays it", async () => {
		const { appId } = await createExplicitBlankApp(USER, PROJECT, "run-t1", {
			status: "generating",
		});
		await upsertThreadTurn({
			target: { kind: "app", appId },
			threadId: "thread-live",
			runId: "run-t1",
			streamId: "s14",
			holderNonce: await holderNonceFor(appId),
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
			expectedProjectId: PROJECT,
		});
		await seedRow("s14", 0, [delta(0), delta(1), { type: "finish" }], {
			appId,
			terminal: true,
		});

		const { frames, ended } = await collectUntil("thread-live", {});
		expect(frames).toEqual([delta(0), delta(1), { type: "finish" }, "[DONE]"]);
		expect(ended).toBe(true);
	});

	it("answers a bare finish for a thread with nothing in flight", async () => {
		const { appId } = await createExplicitBlankApp(USER, PROJECT, "run-t2", {
			status: "generating",
		});
		await upsertThreadTurn({
			target: { kind: "app", appId },
			threadId: "thread-idle",
			runId: "run-t2",
			streamId: "s15",
			holderNonce: await holderNonceFor(appId),
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
			expectedProjectId: PROJECT,
		});
		/* Finalize cleared the marker: nothing to resume. The reply must be a
		 * 200 that terminates on its first chunk: the transport ERRORS on any
		 * non-OK response (it has no null arm on this class). */
		await persistResponseSnapshot({
			target: { kind: "app", appId },
			threadId: "thread-idle",
			streamId: "s15",
			expectedProjectId: PROJECT,
			clearMarker: true,
			responseMessage: null,
		});

		const { frames, ended } = await collectUntil("thread-idle", {
			timeoutMs: 2_000,
		});
		expect(frames).toEqual([{ type: "finish" }, "[DONE]"]);
		expect(ended).toBe(true);
	});

	it("404s a thread scope denial identically to a missing id", async () => {
		const { appId } = await createExplicitBlankApp(USER, PROJECT, "run-t3", {
			status: "generating",
		});
		await upsertThreadTurn({
			target: { kind: "app", appId },
			threadId: "thread-foreign",
			runId: "run-t3",
			streamId: "s16",
			holderNonce: await holderNonceFor(appId),
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
			expectedProjectId: PROJECT,
		});
		await removeMembership();
		requireSessionMock.mockResolvedValue(sessionFor(USER));
		const res = await GET(
			new Request("http://localhost/api/chat/thread-foreign/stream"),
			{ params: Promise.resolve({ streamId: "thread-foreign" }) },
		);
		expect(res.status).toBe(404);
		await res.text();
	});
});

describe("chunk-log retention", () => {
	it("prunes rows past the retention window, keeps fresh ones", async () => {
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
		await seedRow("s10", 0, [delta(0)], { createdAt: old });
		await seedRow("s11", 0, [delta(0)]);

		await pruneChatStreamChunks();

		const remaining = await appDb
			.selectFrom("chat_stream_chunks")
			.select("stream_id")
			.execute();
		expect(remaining.map((r) => r.stream_id)).toEqual(["s11"]);
	});
});
