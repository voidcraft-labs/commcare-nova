/** Real HTTP handlers, architect, Responses decoder, SDK Chat and Postgres.
 * Only authentication and the provider's network destination are controlled.
 * A missing producer step or repeated terminal pause cannot be hidden by a
 * handcrafted UI stream in this regression. */
import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { beforeEach, expect, it, vi } from "vitest";
import { withResponsesPeer } from "@/lib/agent/__tests__/responsesPeer";
import { inputRoundSchema } from "@/lib/chat/inputRound";
import { createInputRoundContinuation } from "@/lib/chat/inputRoundContinuation";
import { NovaChatTransport } from "@/lib/chat/novaChatTransport";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { getCurrentPeriod } from "@/lib/db/period";
import { streamChunkMeta } from "@/lib/db/streamChunks";
import {
	__setListenerConfigForTests,
	closeStreamListener,
} from "@/lib/db/streamListener";
import { loadThread } from "@/lib/db/threads";
import { ChatResponsesPeer } from "./chatResponsesPeer";

const {
	providerTransport,
	resolveOpenAIKey,
	requireSession,
	readSession,
	pauseFault,
	startupFault,
} = vi.hoisted(() => ({
	providerTransport: { current: undefined as typeof fetch | undefined },
	pauseFault: { active: false, attempts: 0 },
	startupFault: { active: false, attempts: 0 },
	resolveOpenAIKey: vi.fn(),
	requireSession: vi.fn(),
	readSession: vi.fn(),
}));
vi.mock("@/lib/auth-utils", () => ({
	resolveOpenAIKey,
	requireSession,
	readSession,
}));
vi.mock("@/lib/agent/openaiProvider", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/agent/openaiProvider")>();
	return {
		...actual,
		createNovaOpenAI: (key: string, transport?: typeof fetch) => {
			const destination = transport ?? providerTransport.current;
			if (!destination)
				throw new Error("The test provider peer is not installed");
			return actual.createNovaOpenAI(key, destination);
		},
	};
});
vi.mock("@/lib/chat/threadInputRounds", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/chat/threadInputRounds")>();
	return {
		...actual,
		commitThreadInputPause: async (
			args: Parameters<typeof actual.commitThreadInputPause>[0],
		) => {
			if (pauseFault.active) {
				pauseFault.attempts++;
				throw new Error("Injected pause persistence outage");
			}
			return actual.commitThreadInputPause(args);
		},
	};
});
vi.mock("@/lib/db/streamChunks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/db/streamChunks")>();
	return {
		...actual,
		appendStreamChunks: async (
			args: Parameters<typeof actual.appendStreamChunks>[0],
		) => {
			if (startupFault.active) {
				startupFault.attempts++;
				throw new Error("Injected initial chunk persistence outage");
			}
			return actual.appendStreamChunks(args);
		},
	};
});
const { POST } = await import("../route");
const { GET } = await import("../[streamId]/stream/route");
const h = setupAppStateTestDb("authoring_continuation_", {
	authSchema: "migrated",
	poolMax: 4,
});
const USER = "continuation-owner",
	PROJECT = "continuation-project",
	THREAD = "continuation-thread";
beforeEach(async () => {
	await h.seedProjectMember(USER, PROJECT, "owner");
	const session = { user: { id: USER } };
	resolveOpenAIKey.mockResolvedValue({
		ok: true,
		apiKey: "local-only",
		session,
	});
	requireSession.mockResolvedValue(session);
	readSession.mockResolvedValue(session);
	await h
		.db()
		.insertInto("credit_months")
		.values({
			user_id: USER,
			period: getCurrentPeriod(),
			allowance: 1000,
			consumed: 0,
			bonus: 0,
			updated_at: new Date().toISOString(),
		})
		.execute();
});

it("resumes two answered rounds through the real SDK, reconnects a detached POST, and leaves a final text pause idle", async () => {
	const peer = new ChatResponsesPeer();
	for (const [callId, question] of [
		["first-question", "Who collects the records?"],
		["second-question", "When is follow-up due?"],
	]) {
		const response = peer.response();
		response.tool(
			"askQuestions",
			{
				header: "A workflow detail",
				questions: [{ question, options: [{ label: "Team choice" }] }],
			},
			{ callId, deltaSize: 4 },
		);
		response.finish();
	}
	const final = peer.response();
	final.text(
		"I have your answers. Please confirm the remaining scope before I build.",
	);
	final.finish();
	const streams = new Set<string>();
	const errors: Error[] = [];
	const postedBodies: Record<string, unknown>[] = [];
	const resumedUrls: string[] = [];
	const observations: unknown[] = [];
	const chats: Chat<UIMessage>[] = [];
	__setListenerConfigForTests(h.uri());
	try {
		await withResponsesPeer(peer.handle, async (_provider, transport) => {
			providerTransport.current = transport;
			try {
				let detached = false;
				const routedFetch: typeof fetch = async (input, init) => {
					const url = new URL(String(input), "http://localhost");
					const request = new Request(url, init);
					if (request.method === "POST" && url.pathname === "/api/chat") {
						postedBodies.push(
							(await request.clone().json()) as Record<string, unknown>,
						);
						const response = await POST(request);
						const streamId = response.headers.get("x-workflow-run-id");
						if (streamId) {
							streams.add(streamId);
							expect(await streamChunkMeta(streamId)).not.toBeNull();
						}
						if (detached || !response.body || !response.ok) return response;
						detached = true;
						// Disconnect after ONE actual SSE record, without inventing or
						// repairing any producer chunks. The transport must replay the
						// remainder from the real route and durable chunk log.
						const reader = response.body.getReader();
						const decoder = new TextDecoder();
						let prefix = "";
						try {
							while (!prefix.includes("\n\n")) {
								const chunk = await reader.read();
								if (chunk.done)
									throw new Error("POST ended before its first frame");
								prefix += decoder.decode(chunk.value, { stream: true });
							}
						} finally {
							await reader.cancel();
							reader.releaseLock();
						}
						return new Response(prefix.slice(0, prefix.indexOf("\n\n") + 2), {
							status: response.status,
							headers: response.headers,
						});
					}
					const match = /^\/api\/chat\/([^/]+)\/stream$/.exec(url.pathname);
					if (request.method !== "GET" || !match)
						throw new Error(`Unexpected chat request ${url.pathname}`);
					resumedUrls.push(url.pathname + url.search);
					observations.push({
						url: url.pathname + url.search,
						chunks: await h
							.db()
							.selectFrom("chat_stream_chunks")
							.select(["stream_id", "first_index", "terminal"])
							.execute(),
						threads: await h
							.db()
							.selectFrom("threads")
							.select(["thread_id", "active_stream_id"])
							.execute(),
					});
					return GET(request, {
						params: Promise.resolve({ streamId: decodeURIComponent(match[1]) }),
					});
				};
				let runId: string | undefined,
					holderNonce: string | undefined,
					designSessionId: string | undefined;
				const continuation = createInputRoundContinuation(null);
				let chat: Chat<UIMessage>;
				const chatTransport = new NovaChatTransport(
					{
						api: "/api/chat",
						fetch: routedFetch,
						prepareSendMessagesRequest: ({ api, messages }) => {
							continuation.markSubmitted();
							return {
								api,
								headers: { "content-type": "application/json" },
								body: {
									messages,
									threadId: THREAD,
									expectedProjectId: PROJECT,
									runId,
									holderNonce,
									designSessionId,
									inputRoundId:
										continuation.round?.state === "pending"
											? continuation.round.id
											: undefined,
								},
							};
						},
					},
					() => chat.messages,
				);
				chat = new Chat({
					id: THREAD,
					transport: chatTransport,
					sendAutomaticallyWhen: ({ messages }) =>
						continuation.claimAutomatic(messages),
					onError: (error) => errors.push(error),
					onData: ({ type, data }) => {
						const value = data as Record<string, unknown>;
						if (type === "data-run-id") runId = value.runId as string;
						if (type === "data-holder-nonce")
							holderNonce = value.holderNonce as string;
						if (type === "data-design-session")
							designSessionId = value.designSessionId as string;
						if (type === "data-input-round")
							continuation.adopt(
								inputRoundSchema.nullable().parse(value.round),
							);
					},
				});
				chats.push(chat);
				await chat.sendMessage({
					text: "Build a simple orchard visit app. Ask about my team and follow-up before building.",
				});
				expect(errors, JSON.stringify(observations)).toEqual([]);
				expect(peer.requests).toHaveLength(1);
				expect(resumedUrls.some((url) => url.includes("startIndex=1"))).toBe(
					true,
				);
				expect(continuation.round).toMatchObject({
					kind: "questions",
					state: "pending",
					toolCallIds: ["first-question"],
				});
				const firstRound = continuation.round?.id;
				await chat.addToolOutput({
					tool: "askQuestions",
					toolCallId: "first-question",
					output: { "0": "Our community team" },
				});
				await expect
					.poll(() => continuation.round?.toolCallIds)
					.toEqual(["second-question"]);
				await expect.poll(() => chat.status).toBe("ready");
				expect(errors, JSON.stringify(observations)).toEqual([]);
				expect(peer.requests).toHaveLength(2);
				expect(postedBodies[1].inputRoundId).toBe(firstRound);
				const secondRound = continuation.round?.id;
				await chat.addToolOutput({
					tool: "askQuestions",
					toolCallId: "second-question",
					output: { "0": "After seven days" },
				});
				await expect.poll(() => continuation.round?.kind).toBe("message");
				await expect.poll(() => chat.status).toBe("ready");
				expect(errors, JSON.stringify(observations)).toEqual([]);
				expect(peer.requests).toHaveLength(3);
				expect(postedBodies[2].inputRoundId).toBe(secondRound);
				expect(postedBodies).toHaveLength(3);
				if (!designSessionId) throw new Error("Missing design session receipt");
				const target = { kind: "design-session" as const, designSessionId };
				const loaded = await loadThread(target, THREAD, USER);
				expect(loaded?.active_stream_id).toBeNull();
				expect(loaded?.input_round).toEqual(continuation.round);
				expect(loaded?.messages).toEqual(chat.messages);
				expect(
					chat.messages
						.at(-1)
						?.parts.filter(
							(part) =>
								part.type === "text" && part.text.includes("Please confirm"),
						),
				).toHaveLength(1);

				let emittedSteps = 0;
				for (const streamId of streams) {
					const rows = await h
						.db()
						.selectFrom("chat_stream_chunks")
						.select("chunks")
						.where("stream_id", "=", streamId)
						.orderBy("first_index")
						.execute();
					let open = false;
					for (const raw of rows.flatMap((row) => row.chunks)) {
						const chunk = raw as { type: string };
						if (chunk.type === "start-step") {
							expect(open).toBe(false);
							open = true;
							emittedSteps++;
						} else if (chunk.type === "finish-step") {
							expect(open).toBe(true);
							open = false;
						} else if (/^(tool|text|reasoning)-/.test(chunk.type))
							expect(open).toBe(true);
					}
					expect(open).toBe(false);
				}
				// Recovery dispatch and final-text publication own frames too.
				// Replay must retain each emitted frame once, whatever that count is.
				expect(
					chat.messages
						.at(-1)
						?.parts.filter((part) => part.type === "step-start"),
				).toHaveLength(emittedSteps);
				// Read back the exact persisted state before replaying stale answers.
				const snapshot = async () => ({
					session: await h
						.db()
						.selectFrom("design_sessions")
						.selectAll()
						.where("id", "=", target.designSessionId)
						.executeTakeFirstOrThrow(),
					thread: await h
						.db()
						.selectFrom("threads")
						.selectAll()
						.where("thread_id", "=", THREAD)
						.executeTakeFirstOrThrow(),
					credit: await h
						.db()
						.selectFrom("credit_months")
						.selectAll()
						.where("user_id", "=", USER)
						.execute(),
					summaries: await h
						.db()
						.selectFrom("run_summaries")
						.selectAll()
						.where("design_session_id", "=", target.designSessionId)
						.execute(),
				});
				const before = await snapshot();
				for (const stale of [postedBodies[1], postedBodies[2]]) {
					const response = await POST(
						new Request("http://localhost/api/chat", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(stale),
						}),
					);
					expect(response.status).toBe(409);
					expect(await response.json()).toMatchObject({
						code: "input_round_stale",
						threadId: THREAD,
					});
				}
				expect(await snapshot()).toEqual(before);
				// A cold SDK instance consumes the real idle reconnect response. A
				// saved answered card does not turn that finish into another POST.
				const hydrated = createInputRoundContinuation(
					loaded?.input_round ?? null,
				);
				let reloaded: Chat<UIMessage>;
				reloaded = new Chat({
					id: THREAD,
					messages: loaded?.messages as UIMessage[],
					transport: new NovaChatTransport(
						{ api: "/api/chat", fetch: routedFetch },
						() => reloaded.messages,
					),
					sendAutomaticallyWhen: ({ messages }) =>
						hydrated.claimAutomatic(messages),
					onError: (error) => errors.push(error),
				});
				chats.push(reloaded);
				await reloaded.resumeStream();
				expect(reloaded.messages).toEqual(loaded?.messages);
				expect(peer.requests).toHaveLength(3);
				expect(postedBodies).toHaveLength(3);
				expect(errors, JSON.stringify(observations)).toEqual([]);
				peer.assertHealthy();
			} finally {
				peer.close();
				for (const chat of chats) await chat.stop();
				for (const streamId of streams)
					await expect
						.poll(async () =>
							(
								await h
									.db()
									.selectFrom("chat_stream_chunks")
									.select("terminal")
									.where("stream_id", "=", streamId)
									.execute()
							).some((row) => row.terminal),
						)
						.toBe(true);
				providerTransport.current = undefined;
			}
		});
	} finally {
		await closeStreamListener();
		__setListenerConfigForTests(null);
	}
}, 30_000);

it("does not publish an actionable pause when its commit and retries fail", async () => {
	const peer = new ChatResponsesPeer();
	const question = peer.response();
	question.tool(
		"askQuestions",
		{
			header: "One detail",
			questions: [{ question: "Who will collect records?", options: [] }],
		},
		{ callId: "uncommitted-question" },
	);
	question.finish();
	await withResponsesPeer(peer.handle, async (_provider, transport) => {
		providerTransport.current = transport;
		pauseFault.active = true;
		pauseFault.attempts = 0;
		let body: Promise<string> | undefined;
		try {
			const response = await POST(
				new Request("http://localhost/api/chat", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						threadId: THREAD,
						expectedProjectId: PROJECT,
						messages: [
							{
								id: "request",
								role: "user",
								parts: [
									{
										type: "text",
										text: "Build an orchard visit app. Ask who collects records first.",
									},
								],
							},
						],
					}),
				}),
			);
			const reading = response.text();
			body = reading;
			const wire = await reading;
			const frames = wire
				.split("\n")
				.filter((line) => line.startsWith("data: {"))
				.map(
					(line) =>
						JSON.parse(line.slice(6)) as {
							type: string;
							data?: { round?: unknown };
						},
				);
			expect(pauseFault.attempts).toBeGreaterThan(1);
			expect(
				frames.some((frame) => frame.type === "tool-input-available"),
			).toBe(true);
			expect(
				frames.filter(
					(frame) => frame.type === "data-input-round" && frame.data?.round,
				),
			).toEqual([]);
			expect(frames.filter((frame) => frame.type === "finish")).toHaveLength(1);
			const thread = await h
				.db()
				.selectFrom("threads")
				.selectAll()
				.where("thread_id", "=", THREAD)
				.executeTakeFirstOrThrow();
			expect(thread.input_round).toBeNull();
			expect(thread.messages).toEqual([
				expect.objectContaining({ role: "user" }),
				expect.objectContaining({
					role: "assistant",
					parts: [
						{ type: "step-start" },
						expect.objectContaining({
							type: "tool-askQuestions",
							toolCallId: "uncommitted-question",
							state: "output-error",
						}),
					],
				}),
			]);
			const session = await h
				.db()
				.selectFrom("design_sessions")
				.selectAll()
				.where("owner_user_id", "=", USER)
				.executeTakeFirstOrThrow();
			expect(session.awaiting_input).toBe(false);
			expect(session.res_settled).toBeNull();
			expect(session.res_run_id).toBeNull();
			expect(session.run_id).toBeNull();
			expect(session.run_holder_nonce).toBeNull();
			expect(session.run_lease_expires_at).toBeNull();
			expect(session.last_error_type).toBe("pause_commit_failed");
			const credit = await h
				.db()
				.selectFrom("credit_months")
				.select("consumed")
				.where("user_id", "=", USER)
				.executeTakeFirstOrThrow();
			expect(credit.consumed).toBe(0);
			peer.assertHealthy();
		} finally {
			peer.close();
			if (body) await body;
			pauseFault.active = false;
			providerTransport.current = undefined;
		}
	});
}, 30_000);

it("refuses a resumable response when its initial durable chunk cannot commit", async () => {
	const peer = new ChatResponsesPeer();
	await withResponsesPeer(peer.handle, async (_provider, transport) => {
		providerTransport.current = transport;
		startupFault.active = true;
		startupFault.attempts = 0;
		let body: Promise<string> | undefined;
		try {
			const response = await POST(
				new Request("http://localhost/api/chat", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						threadId: THREAD,
						expectedProjectId: PROJECT,
						messages: [
							{
								id: "request",
								role: "user",
								parts: [{ type: "text", text: "Build an orchard visit app." }],
							},
						],
					}),
				}),
			);
			body = response.text();
			await body;
			expect(response.status).toBe(503);
			expect(response.headers.get("x-workflow-run-id")).toBeNull();
			expect(startupFault.attempts).toBeGreaterThanOrEqual(2);
			expect(peer.requests).toHaveLength(0);
			const session = await h
				.db()
				.selectFrom("design_sessions")
				.selectAll()
				.where("owner_user_id", "=", USER)
				.executeTakeFirstOrThrow();
			expect(session.awaiting_input).toBe(false);
			expect(session.res_settled).toBeNull();
			expect(session.res_run_id).toBeNull();
			expect(session.run_id).toBeNull();
			expect(session.run_holder_nonce).toBeNull();
			expect(session.run_lease_expires_at).toBeNull();
			const credit = await h
				.db()
				.selectFrom("credit_months")
				.select("consumed")
				.where("user_id", "=", USER)
				.executeTakeFirstOrThrow();
			expect(credit.consumed).toBe(0);
			peer.assertHealthy();
		} finally {
			peer.close();
			if (body) await body;
			startupFault.active = false;
			providerTransport.current = undefined;
		}
	});
}, 30_000);
