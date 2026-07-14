/**
 * The WorkflowChatTransport ↔ resume-route CONTRACT, end-to-end with the real
 * client class — the test that proves a broken chat POST actually resumes.
 *
 * The transport under test is the real `@ai-sdk/workflow` client Nova ships
 * in `ChatContainer`. Its `fetch` is swapped for a router:
 *
 *   POST /api/chat            → a fabricated response that BREAKS mid-stream —
 *                               the first chunks as SSE, no `finish`, with the
 *                               `x-workflow-run-id` header (exactly what the
 *                               chat route emits when a connection drops);
 *   GET  /api/chat/{id}/stream → the REAL route handler, reading the REAL
 *                               chunk log on the per-test Postgres.
 *
 * The transport must detect the missing `finish`, reconnect with
 * `startIndex = chunks received`, and deliver ONE seamless chunk sequence —
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

const { GET } = await import("../route");
const { WorkflowChatTransport } = await import("@ai-sdk/workflow");
const { appendStreamChunks } = await import("@/lib/db/streamChunks");
const { __setListenerConfigForTests, closeStreamListener } = await import(
	"@/lib/db/streamListener"
);
const { createApp } = await import("@/lib/db/apps");
const { appendThreadResponse, upsertThreadTurn } = await import(
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

/** The run's full chunk sequence — what an unbroken POST would have carried. */
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
			appId: "app-1",
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
				// prepareSendMessagesRequest returns — without the explicit
				// content-type, a stringified JSON body defaults to text/plain.
				expect(new Headers(init.headers).get("content-type")).toBe(
					"application/json",
				);
				// The POST breaks after 3 chunks — no finish, no [DONE].
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

		// One seamless sequence — no gap, no overlap, finish included.
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
		 * `reconnectToStream({chatId})` with the Chat instance's id — the
		 * THREAD id — and the endpoint resolves the thread's live stream and
		 * replays it whole. */
		const appId = await createApp(USER, "project-1", "run-1");
		await upsertThreadTurn({
			appId,
			threadId: "thread-1",
			runId: "run-1",
			streamId: STREAM_ID,
			threadType: "build",
			messages: [{ id: "m1", role: "user", parts: [] }],
		});
		await appendStreamChunks({
			streamId: STREAM_ID,
			appId,
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

		// A cold reconnect with no prior POST in this transport instance —
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

	it("resolves a thread with nothing in flight to a clean, terminating no-op", async () => {
		/* The transport THROWS on any non-OK reconnect response, so "nothing
		 * to resume" must be a 200 that terminates on its first chunk — this
		 * pins that the real parser consumes it without erroring or looping. */
		const appId = await createApp(USER, "project-1", "run-2");
		await upsertThreadTurn({
			appId,
			threadId: "thread-2",
			runId: "run-2",
			streamId: "stream-idle",
			threadType: "edit",
			messages: [{ id: "m1", role: "user", parts: [] }],
		});
		await appendThreadResponse({
			appId,
			threadId: "thread-2",
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
