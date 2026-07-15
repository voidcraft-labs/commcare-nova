/**
 * The chat POST against a real Postgres testcontainer — pinning the one
 * contract the whole resumable-threads design hangs on: **a client that
 * disconnects mid-run changes NOTHING server-side.**
 *
 * The regression this exists for: `createUIMessageStream`'s `onEnd` fires
 * through the response stream's `cancel()` hook as well as its natural end,
 * so teardown hung off it ran the moment a user refreshed mid-run — sealing
 * the chunk log with a synthetic `finish` (every later chunk dropped, the
 * resume replayed a truncated stub), flushing a zero-usage accumulator
 * (refunding the charge and latching the real finalize into a no-op), and
 * leaving the app stranded `generating` because `completeAndSettleRun`'s
 * ownership gate no longer matched. The route now runs its safety net in
 * execute's own `finally`, which cannot run before the body settles.
 *
 * The SA is replaced with a hand-driven chunk feed so the test controls
 * exactly when the "model" produces output relative to the disconnect; auth
 * and Project access are mocked; everything else — claim + reservation,
 * durable chunk log, thread persistence, run finalization — is the real
 * code against the real schema.
 */

import type { UIMessageChunk } from "ai";
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
	resolveGatewayKeyMock,
	resolveActiveProjectIdMock,
	resolveAppAccessMock,
	resolveProjectAccessMock,
	createSolutionsArchitectMock,
} = vi.hoisted(() => ({
	resolveGatewayKeyMock: vi.fn(),
	resolveActiveProjectIdMock: vi.fn(),
	resolveAppAccessMock: vi.fn(),
	resolveProjectAccessMock: vi.fn(),
	createSolutionsArchitectMock: vi.fn(),
}));

class MockAppAccessError extends Error {
	readonly name = "AppAccessError";
	constructor(readonly reason: string) {
		super(reason);
	}
}

vi.mock("@/lib/auth-utils", () => ({
	resolveGatewayKey: resolveGatewayKeyMock,
	resolveActiveProjectId: resolveActiveProjectIdMock,
}));
vi.mock("@/lib/db/appAccess", () => ({
	AppAccessError: MockAppAccessError,
	resolveAppAccess: resolveAppAccessMock,
	resolveProjectAccess: resolveProjectAccessMock,
}));
/* Only the SA constructor is faked — `GenerationContext`, the retry loop,
 * the finalizers, and every persistence path stay real. */
vi.mock("@/lib/agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/agent")>()),
	createSolutionsArchitect: createSolutionsArchitectMock,
}));

const { POST } = await import("../route");

const USER = "user-cancel-1";
const PROJECT = "project-cancel-1";
const THREAD = "thread-cancel-1";

const dbHandle = setupPerTestDatabase({ databaseNamePrefix: "chat_cancel_" });

let appDb: Kysely<AppDatabase>;
let harness: PerTestAppDb;

/**
 * A hand-cranked stand-in for the SA's `StreamTextResult`: the test pushes
 * UI message chunks whenever it wants (before/after the simulated
 * disconnect), and `consumeStream()` resolves when `end()` is called — the
 * same "drain reaches the tool loop's terminal state" signal the route keys
 * finalization on.
 */
class ChunkFeed {
	private buffered: UIMessageChunk[] = [];
	private wake: (() => void) | null = null;
	private ended = false;
	private endResolve!: () => void;
	readonly consumed = new Promise<void>((resolve) => {
		this.endResolve = resolve;
	});

	push(...chunks: UIMessageChunk[]): void {
		this.buffered.push(...chunks);
		this.wake?.();
	}

	end(): void {
		this.ended = true;
		this.endResolve();
		this.wake?.();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<UIMessageChunk> {
		for (;;) {
			while (this.buffered.length === 0 && !this.ended) {
				await new Promise<void>((resolve) => {
					this.wake = resolve;
				});
				this.wake = null;
			}
			const next = this.buffered.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			if (this.ended) return;
		}
	}

	/** The two members of `StreamTextResult` the route actually touches. */
	asAgentResult(): {
		consumeStream: () => Promise<void>;
		toUIMessageStream: () => AsyncIterable<UIMessageChunk>;
	} {
		return {
			consumeStream: () => this.consumed,
			toUIMessageStream: () => this,
		};
	}
}

function chatRequest(): Request {
	return new Request("http://localhost/api/chat", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			threadId: THREAD,
			messages: [
				{
					id: "u1",
					role: "user",
					parts: [{ type: "text", text: "build me a simple survey app" }],
				},
			],
		}),
	});
}

/** Poll until `read` returns a defined value or the deadline passes. */
async function pollFor<T>(
	read: () => Promise<T | undefined>,
	timeoutMs = 8_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error("pollFor timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function chunkRows(streamId: string) {
	return appDb
		.selectFrom("chat_stream_chunks")
		.select(["first_index", "chunks", "terminal"])
		.where("stream_id", "=", streamId)
		.orderBy("first_index", "asc")
		.execute();
}

beforeEach(async () => {
	await runCaseStoreMigrations(dbHandle.db);
	harness = createPerTestAppDb(dbHandle.uri);
	appDb = harness.appDb;
	__setAppDbForTests(appDb);

	resolveGatewayKeyMock.mockReset();
	resolveActiveProjectIdMock.mockReset();
	resolveAppAccessMock.mockReset();
	resolveProjectAccessMock.mockReset();
	createSolutionsArchitectMock.mockReset();

	resolveGatewayKeyMock.mockResolvedValue({
		ok: true,
		apiKey: "test-key",
		session: { user: { id: USER } },
	});
	resolveActiveProjectIdMock.mockResolvedValue(PROJECT);
	resolveProjectAccessMock.mockResolvedValue({ projectId: PROJECT });
});

afterEach(async () => {
	__setAppDbForTests(null);
	await harness.destroy();
});

describe("mid-run client disconnect", () => {
	it("changes nothing server-side: the run streams on, finalizes once, and persists in full", async () => {
		const feed = new ChunkFeed();
		createSolutionsArchitectMock.mockReturnValue({
			tools: {},
			stream: async () => feed.asAgentResult(),
		});

		const response = await POST(chatRequest());
		expect(response.status).toBe(200);
		const streamId = response.headers.get("x-workflow-run-id");
		expect(streamId).toBeTruthy();
		if (!streamId || !response.body) throw new Error("no stream to read");

		/* Stream the first half of the "model" output and read it off the live
		 * response, so the cancel below lands mid-run with bytes in flight —
		 * the exact shape of a user refreshing while reasoning streams. */
		feed.push(
			{ type: "start" },
			{ type: "start-step" },
			{ type: "text-start", id: "t1" },
			{ type: "text-delta", id: "t1", delta: "Setting up your app" },
		);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let wire = "";
		while (!wire.includes("Setting up your app")) {
			const { done, value } = await reader.read();
			if (done) throw new Error("response ended before the first delta");
			wire += decoder.decode(value, { stream: true });
		}

		/* The refresh: the browser cancels the response body. Everything the
		 * regression did wrong happened synchronously off this signal. */
		await reader.cancel();

		/* Give any wrongly-wired teardown its chance to run, and the durable
		 * writer's 300 ms batch window time to land the pre-cancel chunks. */
		await pollFor(async () =>
			(await chunkRows(streamId)).length > 0 ? true : undefined,
		);
		await new Promise((r) => setTimeout(r, 500));

		/* Nothing terminal may exist while the run is still live: no sealed
		 * chunk log, no run summary (the premature zero-usage flush), and the
		 * app still generating. */
		const midRows = await chunkRows(streamId);
		expect(midRows.some((row) => row.terminal)).toBe(false);
		const midSummaries = await appDb
			.selectFrom("run_summaries")
			.select(["run_id"])
			.execute();
		expect(midSummaries).toHaveLength(0);
		const midApp = await appDb
			.selectFrom("apps")
			.select(["status"])
			.where("owner", "=", USER)
			.executeTakeFirstOrThrow();
		expect(midApp.status).toBe("generating");

		/* The run finishes AFTER the client left. */
		feed.push(
			{ type: "text-delta", id: "t1", delta: " — done." },
			{ type: "text-end", id: "t1" },
			{ type: "finish-step" },
			{ type: "finish" },
		);
		feed.end();

		/* The real finalize lands on the drain's terminal state: the build
		 * flips complete... */
		const app = await pollFor(async () => {
			const row = await appDb
				.selectFrom("apps")
				.select(["id", "status"])
				.where("owner", "=", USER)
				.executeTakeFirstOrThrow();
			return row.status === "complete" ? row : undefined;
		});
		expect(app.status).toBe("complete");

		/* ...the chunk log carries the POST-disconnect chunks and exactly one
		 * terminal row, sealed by finalize rather than the disconnect... */
		const rows = await pollFor(async () => {
			const all = await chunkRows(streamId);
			return all.some((row) => row.terminal) ? all : undefined;
		});
		const logged = rows.flatMap((row) => row.chunks as UIMessageChunk[]);
		const deltas = logged
			.filter((c) => c.type === "text-delta")
			.map((c) => (c as { delta: string }).delta)
			.join("");
		expect(deltas).toBe("Setting up your app — done.");
		expect(rows.filter((row) => row.terminal)).toHaveLength(1);
		expect(logged.filter((c) => c.type === "finish")).toHaveLength(1);

		/* ...the thread persists the FULL assistant message and retires its
		 * live-stream marker... */
		const thread = await pollFor(async () => {
			const row = await appDb
				.selectFrom("threads")
				.select(["messages", "active_stream_id"])
				.where("thread_id", "=", THREAD)
				.executeTakeFirstOrThrow();
			return row.active_stream_id === null ? row : undefined;
		});
		const messages = thread.messages as {
			role: string;
			parts: { type: string; text?: string }[];
		}[];
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant).toBeDefined();
		const text = (assistant?.parts ?? [])
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("");
		expect(text).toBe("Setting up your app — done.");

		/* ...and the run summary exists exactly once, written at the true end. */
		const summaries = await appDb
			.selectFrom("run_summaries")
			.select(["run_id", "finished_at"])
			.execute();
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.finished_at).toBeTruthy();
	}, 30_000);
});
