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

import type { LanguageModelUsage, UIMessageChunk } from "ai";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationContext } from "@/lib/agent";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	createPerTestAppDb,
	type PerTestAppDb,
} from "@/lib/db/__tests__/perTestAppDb";
import { __setAppDbForTests, type AppDatabase } from "@/lib/db/pg";

const {
	resolveOpenAIKeyMock,
	resolveActiveProjectIdMock,
	resolveAppAccessMock,
	resolveProjectAccessMock,
	projectRoleForInTransactionMock,
	createSolutionsArchitectMock,
	reacquireLeaseMock,
	setAwaitingInputMock,
	clearRunLockMock,
	clearRunLockAndSettleMock,
	completeAndSettleRunMock,
	failAppMock,
	refundReservationMock,
	settleAndReleaseMock,
} = vi.hoisted(() => ({
	resolveOpenAIKeyMock: vi.fn(),
	resolveActiveProjectIdMock: vi.fn(),
	resolveAppAccessMock: vi.fn(),
	resolveProjectAccessMock: vi.fn(),
	projectRoleForInTransactionMock: vi.fn(),
	createSolutionsArchitectMock: vi.fn(),
	reacquireLeaseMock: vi.fn(),
	setAwaitingInputMock: vi.fn(),
	clearRunLockMock: vi.fn(),
	clearRunLockAndSettleMock: vi.fn(),
	completeAndSettleRunMock: vi.fn(),
	failAppMock: vi.fn(),
	refundReservationMock: vi.fn(),
	settleAndReleaseMock: vi.fn(),
}));

class MockAppAccessError extends Error {
	readonly name = "AppAccessError";
	constructor(readonly reason: string) {
		super(reason);
	}
}

vi.mock("@/lib/auth-utils", () => ({
	resolveOpenAIKey: resolveOpenAIKeyMock,
	resolveActiveProjectId: resolveActiveProjectIdMock,
}));
vi.mock("@/lib/db/appAccess", () => ({
	AppAccessError: MockAppAccessError,
	resolveAppAccess: resolveAppAccessMock,
	resolveProjectAccess: resolveProjectAccessMock,
}));
/* New-app creation reauthorizes against the membership row inside the same
 * transaction as the insert. This route test deliberately mocks auth + Project
 * access, so grant that transactional seam explicitly as well. Its locking and
 * denial behavior are covered by the authoritative-writer integration suites. */
vi.mock("@/lib/db/projectMembership", () => ({
	projectRoleForInTransaction: projectRoleForInTransactionMock,
}));
/* Keep the route integration on the real lifecycle writers, but expose the
 * ownership-sensitive calls as pass-through spies. The resume regression can
 * then force only the lease re-acquire read to fail and prove that the route
 * does not infer ownership strongly enough to settle/refund/release anything. */
vi.mock("@/lib/db/apps", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/db/apps")>();
	reacquireLeaseMock.mockImplementation(actual.reacquireLease);
	setAwaitingInputMock.mockImplementation(actual.setAwaitingInput);
	clearRunLockMock.mockImplementation(actual.clearRunLock);
	clearRunLockAndSettleMock.mockImplementation(actual.clearRunLockAndSettle);
	completeAndSettleRunMock.mockImplementation(actual.completeAndSettleRun);
	failAppMock.mockImplementation(actual.failApp);
	return {
		...actual,
		reacquireLease: reacquireLeaseMock,
		setAwaitingInput: setAwaitingInputMock,
		clearRunLock: clearRunLockMock,
		clearRunLockAndSettle: clearRunLockAndSettleMock,
		completeAndSettleRun: completeAndSettleRunMock,
		failApp: failAppMock,
	};
});
vi.mock("@/lib/db/credits", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/db/credits")>();
	refundReservationMock.mockImplementation(actual.refundReservation);
	settleAndReleaseMock.mockImplementation(actual.settleAndRelease);
	return {
		...actual,
		refundReservation: refundReservationMock,
		settleAndRelease: settleAndReleaseMock,
	};
});
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
const RESUME_APP = "app-resume-reacquire-error";
const RESUME_RUN = "run-resume-reacquire-error";
const RESUME_THREAD = "thread-resume-reacquire-error";
const RESERVATION_PERIOD = "2026-07";

const PAUSED_USAGE = {
	inputTokens: 10,
	outputTokens: 5,
	totalTokens: 15,
	reasoningTokens: undefined,
	cachedInputTokens: undefined,
	inputTokenDetails: {
		noCacheTokens: 10,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	},
} as unknown as LanguageModelUsage;

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

function resumeChatRequest(): Request {
	return new Request("http://localhost/api/chat", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			appId: RESUME_APP,
			appReady: true,
			threadId: RESUME_THREAD,
			runId: RESUME_RUN,
			messages: [
				{
					id: "resume-user",
					role: "user",
					parts: [{ type: "text", text: "Which clinics should I include?" }],
				},
				{
					id: "resume-answer",
					role: "assistant",
					parts: [{ type: "text", text: "Include all district clinics." }],
				},
			],
		}),
	});
}

/** Configure the fake SA to finish on an `askQuestions` step. The generation
 * context's step observer is the production pause latch; only the provider is
 * replaced. */
function configurePausedAgent(): void {
	createSolutionsArchitectMock.mockImplementation((ctx: GenerationContext) => ({
		tools: {},
		stream: async () => {
			ctx.handleAgentStep(
				{
					usage: PAUSED_USAGE,
					toolCalls: [
						{
							toolCallId: "pause-question",
							toolName: "askQuestions",
							input: {},
						},
					],
				},
				"Solutions Architect",
			);
			const feed = new ChunkFeed();
			feed.push(
				{ type: "start" },
				{ type: "start-step" },
				{ type: "finish-step" },
				{ type: "finish" },
			);
			feed.end();
			return feed.asAgentResult();
		},
	}));
}

async function expectNoResumablePause(
	response: Response,
	errorType: string,
): Promise<Record<string, unknown>> {
	expect(response.status).toBe(200);
	const wire = await response.text();
	expect(wire).toContain(`"type":"${errorType}"`);

	const thread = await appDb
		.selectFrom("threads")
		.select("active_stream_id")
		.where("thread_id", "=", THREAD)
		.executeTakeFirstOrThrow();
	expect(thread.active_stream_id).toBeNull();

	const app = await appDb
		.selectFrom("apps")
		.selectAll()
		.where("owner", "=", USER)
		.executeTakeFirstOrThrow();
	expect(app.awaiting_input).toBe(false);
	return app as unknown as Record<string, unknown>;
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

	resolveOpenAIKeyMock.mockReset();
	resolveActiveProjectIdMock.mockReset();
	resolveAppAccessMock.mockReset();
	resolveProjectAccessMock.mockReset();
	projectRoleForInTransactionMock.mockReset();
	createSolutionsArchitectMock.mockReset();
	reacquireLeaseMock.mockClear();
	setAwaitingInputMock.mockClear();
	clearRunLockMock.mockClear();
	clearRunLockAndSettleMock.mockClear();
	completeAndSettleRunMock.mockClear();
	failAppMock.mockClear();
	refundReservationMock.mockClear();
	settleAndReleaseMock.mockClear();

	resolveOpenAIKeyMock.mockResolvedValue({
		ok: true,
		apiKey: "test-key",
		session: { user: { id: USER } },
	});
	resolveActiveProjectIdMock.mockResolvedValue(PROJECT);
	resolveProjectAccessMock.mockResolvedValue({ projectId: PROJECT });
	projectRoleForInTransactionMock.mockResolvedValue("editor");
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

describe("pause-stamp ownership admission", () => {
	it("ends as superseded without publishing a resumable pause when a replacement owns the app", async () => {
		configurePausedAgent();
		setAwaitingInputMock.mockImplementationOnce(
			async (appId: string): Promise<"superseded"> => {
				await appDb
					.updateTable("apps")
					.set({ res_run_id: "replacement-run" })
					.where("id", "=", appId)
					.execute();
				return "superseded";
			},
		);

		const app = await expectNoResumablePause(
			await POST(chatRequest()),
			"generation_in_progress",
		);

		expect(setAwaitingInputMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			true,
			USER,
			PROJECT,
		);
		expect(app.status).toBe("generating");
		expect(app.res_run_id).toBe("replacement-run");
		expect(app.res_settled).toBe(false);
	}, 30_000);

	it("ends as released without publishing a resumable pause after the holder was reaped", async () => {
		configurePausedAgent();
		setAwaitingInputMock.mockImplementationOnce(
			async (appId: string): Promise<"released"> => {
				await appDb
					.updateTable("apps")
					.set({
						status: "error",
						error_type: "paused_timeout",
						res_settled: true,
						res_run_id: null,
					})
					.where("id", "=", appId)
					.execute();
				return "released";
			},
		);

		const app = await expectNoResumablePause(
			await POST(chatRequest()),
			"run_released",
		);

		expect(app.status).toBe("error");
		expect(app.error_type).toBe("paused_timeout");
		expect(app.res_settled).toBe(true);
		expect(app.res_run_id).toBeNull();
	}, 30_000);

	it("takes the failure funnel when pause persistence faults instead of claiming a resumable pause", async () => {
		configurePausedAgent();
		setAwaitingInputMock.mockRejectedValueOnce(
			new Error("pause write connection dropped"),
		);

		const app = await expectNoResumablePause(
			await POST(chatRequest()),
			"internal",
		);

		expect(app.status).toBe("error");
		expect(app.error_type).toBe("internal");
		expect(app.res_settled).toBe(true);
	}, 30_000);
});

describe("free-continuation resume admission", () => {
	it("fails closed on an unexpected re-acquire error without touching the holder or its credits", async () => {
		await appDb
			.insertInto("apps")
			.values({
				id: RESUME_APP,
				owner: USER,
				project_id: PROJECT,
				app_name: "Paused app",
				app_name_lower: "paused app",
				connect_type: null,
				case_types: null,
				logo: null,
				module_count: 1,
				form_count: 0,
				mutation_seq: 0,
				status: "complete",
				awaiting_input: true,
				error_type: null,
				deleted_at: null,
				recoverable_until: null,
				run_id: RESUME_RUN,
				res_period: RESERVATION_PERIOD,
				res_reserved: 5,
				res_settled: false,
				res_user_id: USER,
				res_run_id: RESUME_RUN,
				lock_run_id: RESUME_RUN,
				lock_actor_user_id: USER,
				lock_expire_at: new Date(Date.now() + 60_000),
			})
			.execute();
		await appDb
			.insertInto("credit_months")
			.values({
				user_id: USER,
				period: RESERVATION_PERIOD,
				allowance: 1_000,
				consumed: 5,
				bonus: 0,
				updated_at: new Date(),
			})
			.execute();

		const { loadApp } = await import("@/lib/db/apps");
		const app = await loadApp(RESUME_APP);
		if (!app) throw new Error("resume fixture app was not persisted");
		resolveAppAccessMock.mockResolvedValue({
			app,
			projectId: PROJECT,
			role: "editor",
			actorUserId: USER,
		});
		reacquireLeaseMock.mockRejectedValueOnce(
			new Error("database connection dropped during resume admission"),
		);

		const response = await POST(resumeChatRequest());
		expect(response.status).toBe(200);
		const wire = await response.text();

		expect(reacquireLeaseMock).toHaveBeenCalledWith(
			RESUME_APP,
			RESUME_RUN,
			"edit",
			USER,
			PROJECT,
		);
		expect(createSolutionsArchitectMock).not.toHaveBeenCalled();
		expect(wire).toContain('"type":"internal"');
		expect(wire).toContain('"fatal":true');

		const events = await appDb
			.selectFrom("events")
			.select("event")
			.where("app_id", "=", RESUME_APP)
			.where("run_id", "=", RESUME_RUN)
			.execute();
		expect(events).toHaveLength(1);
		expect(events[0]?.event).toEqual(
			expect.objectContaining({
				kind: "conversation",
				payload: {
					type: "error",
					error: {
						type: "internal",
						message: "Something went wrong during generation.",
						fatal: true,
					},
				},
			}),
		);

		/* The failed read proves neither ownership nor loss of ownership. The
		 * paused holder therefore remains byte-for-byte claimable by its own next
		 * retry; this POST may close only its new stream and observability rows. */
		const held = await appDb
			.selectFrom("apps")
			.select([
				"status",
				"awaiting_input",
				"error_type",
				"res_period",
				"res_reserved",
				"res_settled",
				"res_user_id",
				"res_run_id",
				"lock_run_id",
				"lock_actor_user_id",
			])
			.where("id", "=", RESUME_APP)
			.executeTakeFirstOrThrow();
		expect(held).toEqual({
			status: "complete",
			awaiting_input: true,
			error_type: null,
			res_period: RESERVATION_PERIOD,
			res_reserved: 5,
			res_settled: false,
			res_user_id: USER,
			res_run_id: RESUME_RUN,
			lock_run_id: RESUME_RUN,
			lock_actor_user_id: USER,
		});
		const credit = await appDb
			.selectFrom("credit_months")
			.select("consumed")
			.where("user_id", "=", USER)
			.where("period", "=", RESERVATION_PERIOD)
			.executeTakeFirstOrThrow();
		expect(credit.consumed).toBe(5);

		expect(settleAndReleaseMock).not.toHaveBeenCalled();
		expect(refundReservationMock).not.toHaveBeenCalled();
		expect(clearRunLockAndSettleMock).not.toHaveBeenCalled();
		expect(completeAndSettleRunMock).not.toHaveBeenCalled();
		expect(failAppMock).not.toHaveBeenCalled();
		expect(clearRunLockMock).not.toHaveBeenCalled();
	}, 30_000);
});
