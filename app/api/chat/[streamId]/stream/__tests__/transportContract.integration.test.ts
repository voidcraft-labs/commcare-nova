/**
 * The WorkflowChatTransport ↔ resume-route CONTRACT, end-to-end with the real
 * client class: the test that proves a broken chat POST actually resumes.
 *
 * The transport under test is the real `@ai-sdk/workflow` client Nova ships
 * in `ChatContainer`. Its `fetch` is swapped for a router:
 *
 *   POST /api/chat            → a fabricated response that BREAKS mid-stream:
 *                               the first chunks as SSE, no `finish`, with the
 *                               `x-workflow-run-id` header (exactly what the
 *                               chat route emits when a connection drops);
 *   GET  /api/chat/{id}/stream → the REAL route handler, reading the REAL
 *                               chunk log on the per-test Postgres.
 *
 * The transport must detect the missing `finish`, reconnect with
 * `startIndex = chunks received`, and deliver ONE seamless chunk sequence:
 * no gap, no overlap, terminated by the `finish` the log carries. This pins
 * the whole resumability story: SSE encoding compatibility, cursor math,
 * header contract, and close semantics, against the transport's real parser
 * rather than this suite's idea of it.
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

vi.mock("@/lib/auth-utils", () => ({
	requireSession: requireSessionMock,
	getSessionSafe: getSessionSafeMock,
}));
vi.mock("@/lib/db/appAccess", () => ({
	resolveAppScope: resolveAppScopeMock,
	AppAccessError: class extends Error {},
}));
vi.mock("@/lib/db/api-keys", () => ({
	isUserActive: isUserActiveMock,
}));
vi.mock("@/lib/db/projectMembership", () => ({
	projectRoleFor: vi.fn(async () => "editor"),
	projectRoleForInTransaction: vi.fn(async () => "editor"),
}));

const { GET } = await import("../route");
const { WorkflowChatTransport } = await import("@ai-sdk/workflow");
const { appendStreamChunks } = await import("@/lib/db/streamChunks");
const { __setListenerConfigForTests, closeStreamListener } = await import(
	"@/lib/db/streamListener"
);
const { createExplicitBlankApp } = await import("@/lib/db/appGenesis");
const { persistResponseSnapshot, upsertThreadTurn } = await import(
	"@/lib/db/threads"
);

const USER = "user-1";
const dbHandle = setupPerTestDatabase({ databaseNamePrefix: "chat_tport_" });

let appDb: Kysely<AppDatabase>;
let harness: PerTestAppDb;

beforeEach(async () => {
	await runCaseStoreMigrations(dbHandle.db);
	harness = createPerTestAppDb(dbHandle.uri);
	appDb = harness.appDb;
	__setAppDbForTests(appDb);
	__setListenerConfigForTests(dbHandle.uri);

	requireSessionMock.mockReset();
	requireSessionMock.mockResolvedValue({ user: { id: USER } });
	getSessionSafeMock.mockReset();
	getSessionSafeMock.mockResolvedValue({ user: { id: USER } });
	isUserActiveMock.mockReset();
	isUserActiveMock.mockResolvedValue(true);
	resolveAppScopeMock.mockReset();
	resolveAppScopeMock.mockResolvedValue({
		projectId: "project-1",
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

/** Encode chunks the way `createUIMessageStreamResponse` does (SSE frames). */
function sseBody(chunks: unknown[], opts: { done?: boolean } = {}): string {
	let body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
	if (opts.done) body += "data: [DONE]\n\n";
	return body;
}

const STREAM_ID = "post-stream-1";

async function holderNonceFor(appId: string): Promise<string> {
	const row = await appDb
		.selectFrom("apps")
		.select("run_holder_nonce")
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	if (!row.run_holder_nonce) throw new Error("fixture app has no holder nonce");
	return row.run_holder_nonce;
}

/** The run's full chunk sequence: what an unbroken POST would have carried. */
const FULL: UIMessageChunk[] = [
	{ type: "start" } as UIMessageChunk,
	{ type: "text-start", id: "0" } as UIMessageChunk,
	{ type: "text-delta", id: "0", delta: "hel" } as UIMessageChunk,
	{ type: "text-delta", id: "0", delta: "lo" } as UIMessageChunk,
	{ type: "text-end", id: "0" } as UIMessageChunk,
	{ type: "finish" } as UIMessageChunk,
];

describe("WorkflowChatTransport against the real resume route", () => {
	it("stitches a mid-stream POST break back together via the reconnect endpoint", async () => {
		// The durable log carries the WHOLE run (the server kept writing after
		// the client's connection broke), sealed terminal.
		await appendStreamChunks({
			streamId: STREAM_ID,
			target: { kind: "app", appId: "app-1" },
			runId: "run-1",
			firstIndex: 0,
			chunks: FULL,
			terminal: true,
		});

		const requests: string[] = [];
		const routedFetch: typeof fetch = async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
			if (init?.method === "POST") {
				// The transport sends exactly the headers ChatContainer's
				// prepareSendMessagesRequest returns: without the explicit
				// content-type, a stringified JSON body defaults to text/plain.
				expect(new Headers(init.headers).get("content-type")).toBe(
					"application/json",
				);
				// The POST breaks after 3 chunks: no finish, no [DONE].
				return new Response(sseBody(FULL.slice(0, 3)), {
					headers: {
						"content-type": "text/event-stream",
						"x-workflow-run-id": STREAM_ID,
					},
				});
			}
			// Everything else is the real route.
			const streamId = url.pathname.split("/")[3];
			return GET(new Request(url), {
				params: Promise.resolve({ streamId }),
			});
		};

		const transport = new WorkflowChatTransport({
			api: "/api/chat",
			fetch: routedFetch,
			// The same request shape ChatContainer wires: explicit JSON
			// content-type (the transport sends exactly what this returns).
			prepareSendMessagesRequest: ({ api, messages }) => ({
				api,
				headers: { "content-type": "application/json" },
				body: { messages },
			}),
		});

		const stream = await transport.sendMessages({
			trigger: "submit-message",
			chatId: "chat-1",
			messages: [],
			metadata: undefined,
			headers: undefined,
			body: undefined,
		});

		const received: UIMessageChunk[] = [];
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received.push(value);
		}

		// One seamless sequence: no gap, no overlap, finish included.
		expect(received).toEqual(FULL);
		// And it got there the contract's way: POST, then a reconnect GET from
		// exactly the break position.
		expect(requests).toEqual([
			"POST /api/chat",
			`GET /api/chat/${STREAM_ID}/stream?startIndex=3`,
		]);
	});

	it("performs a whole-stream replay by THREAD id (page-refresh shape) via reconnectToStream", async () => {
		/* The refresh-resume path end-to-end: `useChat`'s `resumeStream` calls
		 * `reconnectToStream({chatId})` with the Chat instance's id, the
		 * THREAD id, and the endpoint resolves the thread's live stream and
		 * replays it whole. */
		const { appId } = await createExplicitBlankApp(USER, "project-1", "run-1", {
			status: "generating",
		});
		await upsertThreadTurn({
			target: { kind: "app", appId },
			threadId: "thread-1",
			runId: "run-1",
			streamId: STREAM_ID,
			holderNonce: await holderNonceFor(appId),
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
			expectedProjectId: "project-1",
		});
		await appendStreamChunks({
			streamId: STREAM_ID,
			target: { kind: "app", appId },
			runId: "run-1",
			firstIndex: 0,
			chunks: FULL,
			terminal: true,
		});

		const routedFetch: typeof fetch = async (input) => {
			const url = new URL(String(input), "http://localhost");
			const streamId = url.pathname.split("/")[3];
			return GET(new Request(url), {
				params: Promise.resolve({ streamId }),
			});
		};

		const transport = new WorkflowChatTransport({
			api: "/api/chat",
			fetch: routedFetch,
		});

		// A cold reconnect with no prior POST in this transport instance:
		// the chatId (= thread id) maps via the default `{api}/{chatId}/stream`.
		const stream = await transport.reconnectToStream({
			chatId: "thread-1",
			metadata: undefined,
			headers: undefined,
			body: undefined,
		});
		expect(stream).not.toBeNull();

		const received: UIMessageChunk[] = [];
		const reader = (stream as ReadableStream<UIMessageChunk>).getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received.push(value);
		}
		expect(received).toEqual(FULL);
	});

	it("windows a cold thread resume client-side: the full replay folds into a seeded transcript without duplication, and transient data replays whole", async () => {
		/* The barrier-persistence resume shape: every completed step is already
		 * in the thread transcript the client hydrated, so `NovaChatTransport`
		 * (the ChatContainer class) cold-resumes with a FULL replay
		 * (`startIndex=0`) and drops the already-hydrated steps' content
		 * client-side, windowed on its own copy of the message the replay's
		 * `start` chunk names — while
		 * transient `data-*` chunks (events, receipts) pass through from chunk
		 * 0, because they live nowhere but this log. Folding what's left into
		 * a message seeded from the barrier transcript must not duplicate the
		 * completed step's parts. */
		const { appId } = await createExplicitBlankApp(USER, "project-1", "run-3", {
			status: "generating",
		});
		await upsertThreadTurn({
			target: { kind: "app", appId },
			threadId: "thread-3",
			runId: "run-3",
			streamId: "stream-midrun",
			holderNonce: await holderNonceFor(appId),
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
			expectedProjectId: "project-1",
		});
		/* The log exactly as the chat POST writes it: the seed-steps statement
		 * first, the run receipt, then step 1 complete (its barrier persisted
		 * it) and step 2 open at the end; terminal so the route closes instead
		 * of tailing. */
		await appendStreamChunks({
			streamId: "stream-midrun",
			target: { kind: "app", appId },
			runId: "run-3",
			firstIndex: 0,
			chunks: [
				{ type: "data-seed-steps", data: { steps: 0 }, transient: true },
				{ type: "data-run-id", data: { runId: "run-3" }, transient: true },
				{ type: "start", messageId: "a1" },
				{ type: "start-step" },
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", delta: "Step one." },
				{ type: "text-end", id: "t1" },
				{ type: "finish-step" },
				{ type: "start-step" },
				{ type: "text-start", id: "t2" },
				{ type: "text-delta", id: "t2", delta: "Step two" },
				{ type: "text-end", id: "t2" },
				{ type: "finish" },
			],
			terminal: true,
		});

		/* The barrier-persisted transcript's trailing assistant message: what
		 * the client's Chat seeds its resume fold with, and what the transport
		 * windows the replay against. */
		const seeded = {
			id: "a1",
			role: "assistant" as const,
			parts: [
				{ type: "step-start" as const },
				{ type: "text" as const, text: "Step one.", state: "done" as const },
			],
		};

		const requests: string[] = [];
		const routedFetch: typeof fetch = async (input) => {
			const url = new URL(String(input), "http://localhost");
			requests.push(`GET ${url.pathname}${url.search}`);
			const streamId = url.pathname.split("/")[3];
			return GET(new Request(url), {
				params: Promise.resolve({ streamId }),
			});
		};

		const { NovaChatTransport } = await import("@/lib/chat/novaChatTransport");
		const transport = new NovaChatTransport(
			{
				api: "/api/chat",
				fetch: routedFetch,
			},
			() => [{ id: "m1", role: "user", parts: [] }, seeded],
		);
		const stream = await transport.reconnectToStream({
			chatId: "thread-3",
			metadata: undefined,
			headers: undefined,
			body: undefined,
		});
		expect(stream).not.toBeNull();
		expect(requests).toEqual(["GET /api/chat/thread-3/stream?startIndex=0"]);

		const received: UIMessageChunk[] = [];
		const reader = (stream as ReadableStream<UIMessageChunk>).getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received.push(value);
		}

		/* The transient receipts and the identity-bearing `start` replayed from
		 * chunk 0; step 1's content — the hydrated step — did not. */
		expect(received.map((c) => c.type)).toEqual([
			"data-seed-steps",
			"data-run-id",
			"start",
			"start-step",
			"text-start",
			"text-delta",
			"text-end",
			"finish",
		]);

		const { readUIMessageStream } = await import("ai");
		let folded: { parts: { type: string; text?: string }[] } | undefined;
		const refeed = new ReadableStream<UIMessageChunk>({
			start(controller) {
				for (const chunk of received) controller.enqueue(chunk);
				controller.close();
			},
		});
		for await (const snapshot of readUIMessageStream({
			message: seeded,
			stream: refeed,
		})) {
			folded = snapshot as typeof folded;
		}

		/* One "Step one." (from the seed), one "Step two" (from the replay) —
		 * nothing duplicated, nothing lost. */
		expect(
			folded?.parts.map((p) => (p.type === "text" ? p.text : p.type)),
		).toEqual(["step-start", "Step one.", "step-start", "Step two"]);
	});

	it("resolves a thread with nothing in flight to a clean, terminating no-op", async () => {
		/* The transport THROWS on any non-OK reconnect response, so "nothing
		 * to resume" must be a 200 that terminates on its first chunk, this
		 * pins that the real parser consumes it without erroring or looping. */
		const { appId } = await createExplicitBlankApp(USER, "project-1", "run-2", {
			status: "generating",
		});
		await upsertThreadTurn({
			target: { kind: "app", appId },
			threadId: "thread-2",
			runId: "run-2",
			streamId: "stream-idle",
			holderNonce: await holderNonceFor(appId),
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
			expectedProjectId: "project-1",
		});
		await persistResponseSnapshot({
			target: { kind: "app", appId },
			threadId: "thread-2",
			streamId: "stream-idle",
			expectedProjectId: "project-1",
			clearMarker: true,
			responseMessage: null,
		});

		const routedFetch: typeof fetch = async (input) => {
			const url = new URL(String(input), "http://localhost");
			const streamId = url.pathname.split("/")[3];
			return GET(new Request(url), {
				params: Promise.resolve({ streamId }),
			});
		};

		const transport = new WorkflowChatTransport({
			api: "/api/chat",
			fetch: routedFetch,
		});

		const stream = await transport.reconnectToStream({
			chatId: "thread-2",
			metadata: undefined,
			headers: undefined,
			body: undefined,
		});
		expect(stream).not.toBeNull();

		const received: UIMessageChunk[] = [];
		const reader = (stream as ReadableStream<UIMessageChunk>).getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received.push(value);
		}
		expect(received).toEqual([{ type: "finish" }]);
	});
});
