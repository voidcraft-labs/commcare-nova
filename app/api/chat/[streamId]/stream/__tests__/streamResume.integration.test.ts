/**
 * The resumable chat-stream route against a real Postgres testcontainer —
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
 *     retry math).
 *   - LIVE tail: chunks appended AFTER the stream opened arrive via the
 *     `nova_chat_stream` poke — end-to-end NOTIFY delivery.
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
 * Auth (`requireSession` / `getSessionSafe` / `resolveAppScope` /
 * `isUserActive`) is mocked exactly like the app relay's suite — the chunk
 * log, the LISTEN path, and the route's own replay/tail/fallback logic are
 * the code under test.
 */

import type { UIMessageStreamWriter } from "ai";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	createPerTestAppDb,
	type PerTestAppDb,
} from "@/lib/db/__tests__/perTestAppDb";
import { __setAppDbForTests, type AppDatabase } from "@/lib/db/pg";

const {
	requireSessionMock,
	getSessionSafeMock,
	resolveAppScopeMock,
	isUserActiveMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	getSessionSafeMock: vi.fn(),
	resolveAppScopeMock: vi.fn(),
	isUserActiveMock: vi.fn(),
}));

/* A real `AppAccessError` shape — the route revokes only on this class. */
class MockAppAccessError extends Error {
	readonly name = "AppAccessError";
	constructor(readonly reason: string) {
		super(reason);
	}
}

vi.mock("@/lib/auth-utils", () => ({
	requireSession: requireSessionMock,
	getSessionSafe: getSessionSafeMock,
}));
vi.mock("@/lib/db/appAccess", () => ({
	resolveAppScope: resolveAppScopeMock,
	AppAccessError: MockAppAccessError,
}));
vi.mock("@/lib/db/api-keys", () => ({
	isUserActive: isUserActiveMock,
}));
vi.mock("@/lib/db/projectMembership", () => ({
	projectRoleFor: vi.fn(async () => "editor"),
	projectRoleForInTransaction: vi.fn(async () => "editor"),
}));

/* Module-load cadence — set BEFORE the dynamic import so the fallback and
 * revocation tests observe their close in milliseconds, not the prod ~10 s. */
process.env.NOVA_CHAT_STREAM_CADENCE_MS = "150";

const { GET } = await import("../route");
const { appendStreamChunks, pruneChatStreamChunks } = await import(
	"@/lib/db/streamChunks"
);
const { DurableStreamWriter } = await import("@/lib/chat/durableStreamWriter");
const { holderNonceReplayDigest, PRIVATE_HOLDER_NONCE_CHUNK_TYPE } =
	await import("@/lib/chat/privateHolderNonce");
const { __setListenerConfigForTests, closeStreamListener } = await import(
	"@/lib/db/streamListener"
);
const { claimAndReserveRun, createApp } = await import("@/lib/db/apps");
const { declareRuntimeReader } = await import("@/lib/db/runtimeReaderVersion");
const { appendThreadResponse, upsertThreadTurn } = await import(
	"@/lib/db/threads"
);

const USER = "user-1";
const PEER = "user-2";
const PROJECT = "project-1";
const SUCCESSOR_NONCE = "00000000-0000-4000-8000-000000000099";

const dbHandle = setupPerTestDatabase({ databaseNamePrefix: "chat_stream_" });

let appDb: Kysely<AppDatabase>;
let harness: PerTestAppDb;

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
	return { user: { id: userId } } as never;
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

const delta = (i: number) => ({ type: "text-delta", id: "0", delta: `c${i}` });

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
 * The deadline aborts `req.signal` so the pending read resolves `done` —
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

	const opened = Promise.resolve(opts.onOpen?.());

	try {
		while (true) {
			const chunk = await reader.read().catch(() => ({
				done: true as const,
				value: undefined,
			}));
			if (chunk.value) {
				raw += decoder.decode(chunk.value, { stream: true });
				frames.length = 0;
				frames.push(...parseFrames(raw));
			}
			if (chunk.done) {
				ended = !timedOut;
				break;
			}
		}
	} finally {
		clearTimeout(deadline);
		controller.abort();
		await reader.cancel().catch(() => {});
		await opened;
	}
	return { frames, response, ended };
}

beforeEach(async () => {
	await runCaseStoreMigrations(dbHandle.db);
	harness = createPerTestAppDb(dbHandle.uri);
	appDb = harness.appDb;
	__setAppDbForTests(appDb);
	__setListenerConfigForTests(dbHandle.uri);

	requireSessionMock.mockReset();
	getSessionSafeMock.mockReset();
	resolveAppScopeMock.mockReset();
	isUserActiveMock.mockReset();
	getSessionSafeMock.mockResolvedValue(sessionFor(USER));
	isUserActiveMock.mockResolvedValue(true);
	resolveAppScopeMock.mockResolvedValue({
		projectId: PROJECT,
		role: "editor",
		actorUserId: USER,
	});
});

afterEach(async () => {
	await closeStreamListener();
	__setListenerConfigForTests(null);
	__setAppDbForTests(null);
	await harness.destroy();
});

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

		const { frames, ended } = await collectUntil("s4", {
			onOpen: async () => {
				// The real append path — INSERT + pg_notify on the per-test DB.
				await appendStreamChunks({
					streamId: "s4",
					appId: "app-1",
					runId: "run-1",
					firstIndex: 1,
					chunks: [delta(1), { type: "finish" }],
					terminal: true,
				});
			},
		});
		expect(frames).toEqual([delta(0), delta(1), { type: "finish" }, "[DONE]"]);
		expect(ended).toBe(true);
	});

	it("round-trips the DurableStreamWriter's log, synthetic finish included", async () => {
		const inner: UIMessageStreamWriter = {
			write() {},
			merge() {},
			onError: undefined,
		};
		const writer = new DurableStreamWriter({
			streamId: "s5",
			appId: "app-1",
			runId: "run-1",
			threadId: "thread-1",
			inner,
		});
		writer.write({
			type: "data-run-id",
			data: { runId: "run-1" },
			transient: true,
		});
		writer.write(delta(0) as never);
		// No explicit finish — an error-terminated POST; close() synthesizes it.
		await writer.close();

		const { frames } = await collectUntil("s5", {});
		expect(frames).toEqual([
			{ type: "data-run-id", data: { runId: "run-1" }, transient: true },
			delta(0),
			{ type: "finish" },
			"[DONE]",
		]);
	});

	it("rehydrates a private holder marker only for its actor and preserves the cursor for peers", async () => {
		const appId = await createApp(USER, PROJECT, "run-private");
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
			appId,
			threadId: "thread-private",
			runId: "run-private",
			streamId: "s-private",
			holderNonce,
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
		});
		const inner: UIMessageStreamWriter = {
			write() {},
			merge() {},
			onError: undefined,
		};
		const writer = new DurableStreamWriter({
			streamId: "s-private",
			appId,
			runId: "run-private",
			threadId: "thread-private",
			inner,
		});
		writer.writePrivateHolderNonce(holderNonce);
		await writer.close();
		/* Paused finalization clears the live stream marker but deliberately
		 * retains the nonce for the answer POST. A direct hot reconnect to the
		 * completed stream must still rehydrate this exact generation. */
		await appDb.transaction().execute(async (tx) => {
			await declareRuntimeReader(tx);
			await tx
				.updateTable("apps")
				.set({ awaiting_input: true })
				.where("id", "=", appId)
				.execute();
		});
		await appendThreadResponse({
			appId,
			threadId: "thread-private",
			streamId: "s-private",
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
			appId,
			threadId: "thread-private",
			runId: "run-private",
			streamId: "s-successor",
			holderNonce: SUCCESSOR_NONCE,
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
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
		// No apps row at all → `appHeldLive` is false on every tick.
		await seedRow("s6", 0, [delta(0)], { appId: "app-gone" });

		const { frames, ended } = await collectUntil("s6", {
			timeoutMs: 3_000,
		});
		expect(frames).toEqual([delta(0), { type: "finish" }, "[DONE]"]);
		expect(ended).toBe(true);
	});

	it("keeps tailing while the app is held live", async () => {
		// A real `generating` app row with a fresh `updated_at` → lease live.
		const appId = await createApp(USER, PROJECT, "run-live");
		await seedRow("s7", 0, [delta(0)], { appId });

		const { frames } = await collectUntil("s7", {
			// Several cadence ticks pass before the terminal lands; the fallback
			// must not fire in between (deadTicks resets while live).
			onOpen: async () => {
				await new Promise((r) => setTimeout(r, 600));
				await appendStreamChunks({
					streamId: "s7",
					appId,
					runId: "run-live",
					firstIndex: 1,
					chunks: [delta(1), { type: "finish" }],
					terminal: true,
				});
			},
			timeoutMs: 5_000,
		});
		// Exactly one finish — the appended one, no premature synthetic.
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
		// Drain the JSON body — an unread `NextResponse.json` stream is an
		// async resource the leak gate flags.
		await res.text();
	});

	it("404s a scope denial identically to a missing stream", async () => {
		await seedRow("s8", 0, [delta(0)]);
		resolveAppScopeMock.mockRejectedValue(new MockAppAccessError("not-member"));
		requireSessionMock.mockResolvedValue(sessionFor(USER));
		const res = await GET(new Request("http://localhost/api/chat/s8/stream"), {
			params: Promise.resolve({ streamId: "s8" }),
		});
		expect(res.status).toBe(404);
		await res.text();
	});

	it("closes on a CONFIRMED mid-stream membership loss, not on a transient throw", async () => {
		const appId = await createApp(USER, PROJECT, "run-revoke");
		await seedRow("s9", 0, [delta(0)], { appId });

		// Transient scope throws (pool blip) must NOT close the stream.
		resolveAppScopeMock
			.mockResolvedValueOnce({
				projectId: PROJECT,
				role: "editor",
				actorUserId: USER,
			}) // connect-time gate
			.mockRejectedValueOnce(new Error("pool exhausted")) // tick 1: transient
			.mockRejectedValue(new MockAppAccessError("removed")); // then: confirmed

		const { frames, ended } = await collectUntil("s9", {
			timeoutMs: 3_000,
		});
		// Closed WITHOUT [DONE] — a revoked tail is not a completed stream.
		expect(ended).toBe(true);
		expect(frames).toEqual([delta(0)]);
	});
});

describe("append idempotency", () => {
	it("converges a retried append of the same (stream, firstIndex) batch instead of raising", async () => {
		// The writer's in-chain retry can re-send a batch whose INSERT actually
		// committed (lost ack, or a failed advisory poke on the first call) —
		// the duplicate must be a no-op, not a PK violation that marks the
		// stream broken.
		const batch = {
			streamId: "s13",
			appId: "app-1",
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
		const appId = await createApp(USER, PROJECT, "run-t1");
		await upsertThreadTurn({
			appId,
			threadId: "thread-live",
			runId: "run-t1",
			streamId: "s14",
			holderNonce: await holderNonceFor(appId),
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
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
		const appId = await createApp(USER, PROJECT, "run-t2");
		await upsertThreadTurn({
			appId,
			threadId: "thread-idle",
			runId: "run-t2",
			streamId: "s15",
			holderNonce: await holderNonceFor(appId),
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
		});
		/* Finalize cleared the marker — nothing to resume. The reply must be a
		 * 200 that terminates on its first chunk: the transport ERRORS on any
		 * non-OK response (it has no null arm on this class). */
		await appendThreadResponse({
			appId,
			threadId: "thread-idle",
			streamId: "s15",
			responseMessage: null,
		});

		const { frames, ended } = await collectUntil("thread-idle", {
			timeoutMs: 2_000,
		});
		expect(frames).toEqual([{ type: "finish" }, "[DONE]"]);
		expect(ended).toBe(true);
	});

	it("404s a thread scope denial identically to a missing id", async () => {
		const appId = await createApp(USER, PROJECT, "run-t3");
		await upsertThreadTurn({
			appId,
			threadId: "thread-foreign",
			runId: "run-t3",
			streamId: "s16",
			holderNonce: await holderNonceFor(appId),
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
		});
		resolveAppScopeMock.mockRejectedValue(new MockAppAccessError("not-member"));
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
