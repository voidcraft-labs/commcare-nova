/**
 * The design-session build turn against a real Postgres testcontainer: the
 * wire and lifecycle pins for the chat POST that starts (or continues) a
 * build WITHOUT an early app row.
 *
 * A fresh build creates + claims a design session in one gated transaction
 * and runs the BUILD ORCHESTRATOR — never the SA — so the orchestrator is
 * mocked at its module seam (the real one drives the design pipeline's live
 * model calls) and everything else is real code against the real schema:
 * session creation + claim + reservation, the durable chunk log, the
 * session-targeted thread, run finalization per outcome, and the
 * completed-build finishing order (settle → `data-done`).
 *
 * The wire this pins is the cutover's client contract: the early
 * `data-app-id` frame is GONE; `data-design-session` announces the turn's
 * scope (null `materializedAppId` while no app exists), and the strict
 * `data-app-materialized` receipt lands only when the first meaningful
 * workflow commits — always before `data-done`.
 */

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it as test, vi } from "vitest";
import { readMaterializedGenesisReceipt } from "@/lib/agent/change-set/materializeGenesis";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import { CREDITS_PER_BUILD } from "@/lib/db/creditPolicy";
import {
	createAndClaimDesignSessionRun,
	setDesignSessionAwaitingInput,
} from "@/lib/db/designSessions";
import { getCurrentPeriod } from "@/lib/db/period";
import type { AppDatabase } from "@/lib/db/pg";
import { materializeDesignFixture } from "./materializeDesignFixture";

const {
	resolveOpenAIKeyMock,
	createSolutionsArchitectMock,
	runBuildOrchestrationMock,
} = vi.hoisted(() => ({
	resolveOpenAIKeyMock: vi.fn(),
	createSolutionsArchitectMock: vi.fn(),
	runBuildOrchestrationMock:
		vi.fn<
			typeof import("@/lib/agent/build/orchestrator").runBuildOrchestration
		>(),
}));

vi.mock("@/lib/auth-utils", () => ({
	resolveOpenAIKey: resolveOpenAIKeyMock,
}));

vi.mock("@/lib/agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/agent")>()),
	createSolutionsArchitect: createSolutionsArchitectMock,
}));
vi.mock("@/lib/agent/build/orchestrator", () => ({
	runBuildOrchestration: runBuildOrchestrationMock,
}));

const { POST: originalPOST } = await import("../route");
const responses = new Set<Response>();
const bodies = new Set<Promise<string>>();
function it(name: string, run: () => Promise<void>, timeout = 30_000): void {
	test(
		name,
		async () => {
			try {
				await run();
			} finally {
				for (const response of responses) {
					if (!response.bodyUsed) bodies.add(response.text());
				}
				await Promise.all(bodies);
				responses.clear();
				bodies.clear();
			}
		},
		timeout,
	);
}
async function POST(request: Request): Promise<Response> {
	const response = await originalPOST(request);
	responses.add(response);
	return response;
}
function responseText(response: Response): Promise<string> {
	const body = response.text();
	bodies.add(body);
	return body;
}

const USER = "user-design-1";
const PROJECT = "project-design-1";
const THREAD = "thread-design-1";

const h = setupAppStateTestDb("chat_designbuild_", {
	authSchema: "migrated",
	poolMax: 4,
});

let appDb: Kysely<AppDatabase>;

function buildRequest(args: { designSessionId?: string } = {}): Request {
	return new Request("http://localhost/api/chat", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			threadId: THREAD,
			expectedProjectId: PROJECT,
			...(args.designSessionId
				? { designSessionId: args.designSessionId }
				: {}),
			messages: [
				{
					id: "u1",
					role: "user",
					parts: [{ type: "text", text: "build me a case tracking app" }],
				},
			],
		}),
	});
}

/** The wire, parsed into its SSE data payloads. */
function wireChunks(wire: string): { type: string; data?: unknown }[] {
	return wire
		.split("\n")
		.filter((line) => line.startsWith("data: {"))
		.map((line) => JSON.parse(line.slice("data: ".length)));
}

async function sessionRow() {
	return appDb
		.selectFrom("design_sessions")
		.selectAll()
		.where("owner_user_id", "=", USER)
		.executeTakeFirstOrThrow();
}

async function threadRow() {
	return appDb
		.selectFrom("threads")
		.select([
			"app_id",
			"design_session_id",
			"thread_type",
			"active_stream_id",
			"active_holder_nonce",
			"messages",
		])
		.where("thread_id", "=", THREAD)
		.executeTakeFirstOrThrow();
}

beforeEach(async () => {
	appDb = h.db();
	await h.seedProjectMember(USER, PROJECT);

	resolveOpenAIKeyMock.mockReset();
	createSolutionsArchitectMock.mockReset();
	runBuildOrchestrationMock.mockReset();
	runBuildOrchestrationMock.mockRejectedValue(
		new Error("runBuildOrchestration invoked without a per-test configuration"),
	);

	resolveOpenAIKeyMock.mockResolvedValue({
		ok: true,
		apiKey: "test-key",
		session: { user: { id: USER } },
	});

	await appDb
		.insertInto("credit_months")
		.values({
			user_id: USER,
			period: getCurrentPeriod(),
			allowance: 1_000,
			consumed: 0,
			bonus: 0,
			updated_at: new Date().toISOString(),
		})
		.execute();
});

describe("design-session build turns", () => {
	it("hides an unmaterialized session from Project co-members before touching its thread", async () => {
		runBuildOrchestrationMock.mockImplementation(async (args) => {
			args.meter?.track({ inputTokens: 10, outputTokens: 5 });
			args.writer.write({ type: "start", messageId: args.responseMessageId });
			args.writer.write({ type: "start-step" });
			args.writer.write({ type: "text-start", id: "owner-private" });
			args.writer.write({
				type: "text-delta",
				id: "owner-private",
				delta: "Designing your app.",
			});
			args.writer.write({ type: "text-end", id: "owner-private" });
			args.writer.write({ type: "finish-step" });
			args.writer.write({ type: "finish" });
			const paused = await setDesignSessionAwaitingInput(
				args.designSessionId,
				args.runId,
				args.holderNonce,
				true,
				USER,
				PROJECT,
			);
			return { kind: "awaiting-input", pauseOwned: paused === "owned" };
		});
		const first = await POST(buildRequest());
		expect(first.status).toBe(200);
		await responseText(first);
		const before = await threadRow();

		await h.seedProjectMember("other-project-member", PROJECT);
		const otherSession = await createAndClaimDesignSessionRun({
			actorUserId: "other-project-member",
			projectId: PROJECT,
			runId: "other-owner-run",
			cost: CREDITS_PER_BUILD,
		});

		/* THREAD belongs to the first session. The private-session admission must
		 * win before that mismatch can produce the thread guard's distinct 400. */
		const denied = await POST(
			buildRequest({
				designSessionId: otherSession.designSessionId,
			}),
		);
		expect(denied.status).toBe(404);
		expect(await denied.json()).toEqual({
			error: "App not found",
			type: "not_found",
		});
		const after = await threadRow();
		expect(after.messages).toEqual(before.messages);
		expect(runBuildOrchestrationMock).toHaveBeenCalledTimes(1);
	}, 30_000);

	it("creates + claims a session pre-stream, announces it on the wire, and pauses holding the reservation", async () => {
		runBuildOrchestrationMock.mockImplementation(async (args) => {
			/* A real pipeline meters its model calls; the paused hold survives
			 * flush because the run earned its cost. */
			args.meter?.track({ inputTokens: 100, outputTokens: 50 });
			args.writer.write({ type: "start", messageId: args.responseMessageId });
			args.writer.write({ type: "start-step" });
			args.writer.write({ type: "text-start", id: "n1" });
			args.writer.write({
				type: "text-delta",
				id: "n1",
				delta: "Designing your app.",
			});
			args.writer.write({ type: "text-end", id: "n1" });
			args.writer.write({ type: "finish-step" });
			args.writer.write({ type: "finish" });
			const paused = await setDesignSessionAwaitingInput(
				args.designSessionId,
				args.runId,
				args.holderNonce,
				true,
				USER,
				PROJECT,
			);
			return { kind: "awaiting-input", pauseOwned: paused === "owned" };
		});

		const response = await POST(buildRequest());
		expect(response.status).toBe(200);
		const streamId = response.headers.get("x-workflow-run-id");
		const wire = await responseText(response);
		const chunks = wireChunks(wire);

		/* The session exists with this run's claim + reservation intact (a
		 * paused round keeps its hold for the answering POST). */
		const session = await sessionRow();
		expect(session.state).toBe("active");
		expect(session.mode).toBe("build");
		expect(session.project_id).toBe(PROJECT);
		expect(session.proposed_app_id).not.toBeNull();
		expect(session.app_id).toBeNull();
		expect(session.run_id).not.toBeNull();
		expect(session.res_reserved).toBe(CREDITS_PER_BUILD);
		expect(session.res_settled).toBe(false);
		expect(session.awaiting_input).toBe(true);

		/* The orchestrator received the session's exact scope, pre-app. */
		expect(runBuildOrchestrationMock).toHaveBeenCalledTimes(1);
		expect(runBuildOrchestrationMock.mock.calls[0]?.[0]).toMatchObject({
			designSessionId: session.id,
			proposedAppId: session.proposed_app_id,
			projectId: PROJECT,
			materializedAppId: null,
			threadId: THREAD,
		});
		expect(createSolutionsArchitectMock).not.toHaveBeenCalled();

		/* The wire announces the design scope — and never an app id. */
		const announce = chunks.find((c) => c.type === "data-design-session");
		expect(announce?.data).toEqual({
			designSessionId: session.id,
			materializedAppId: null,
		});
		expect(chunks.some((c) => c.type === "data-app-id")).toBe(false);
		expect(chunks.some((c) => c.type === "data-app-materialized")).toBe(false);
		expect(wire).toContain("Designing your app.");

		/* The thread is session-targeted; the pause retires the stream marker
		 * (the round is complete) but RETAINS the holder nonce — the paused
		 * run's continuation capability for the answering POST. */
		expect(streamId).toBeTruthy();
		const thread = await threadRow();
		expect(thread.design_session_id).toBe(session.id);
		expect(thread.app_id).toBeNull();
		expect(thread.thread_type).toBe("build");
		expect(thread.active_stream_id).toBeNull();
		expect(thread.active_holder_nonce).not.toBeNull();

		/* The run summary books against the session at the build shape. */
		const summary = await appDb
			.selectFrom("run_summaries")
			.select(["app_id", "design_session_id", "prompt_mode", "app_ready"])
			.executeTakeFirstOrThrow();
		expect(summary).toEqual({
			app_id: null,
			design_session_id: session.id,
			prompt_mode: "build",
			app_ready: false,
		});
	}, 30_000);

	it("a failed pre-app outcome settles + refunds the session hold and claws the turn back", async () => {
		runBuildOrchestrationMock.mockImplementation(async (args) => {
			args.writer.write({ type: "start", messageId: args.responseMessageId });
			args.writer.write({ type: "finish" });
			return {
				kind: "failed",
				errorType: "internal",
				message: "The design pipeline could not produce a reviewed plan.",
				recoverable: true,
				appId: null,
			};
		});

		const response = await POST(buildRequest());
		expect(response.status).toBe(200);
		const wire = await responseText(response);
		const chunks = wireChunks(wire);

		/* The session survives (recoverable scope), its hold settled and the
		 * charge refunded — no app row was ever minted. */
		const session = await sessionRow();
		expect(session.state).toBe("active");
		/* The failed run's terminal writer releases the whole authority tuple —
		 * holder and marker leave together. */
		expect(session.run_id).toBeNull();
		expect(session.res_settled).toBeNull();
		expect(session.res_reserved).toBeNull();
		expect(session.last_error_type).toBe("internal");
		const apps = await appDb.selectFrom("apps").select("id").execute();
		expect(apps).toHaveLength(0);
		const credit = await appDb
			.selectFrom("credit_months")
			.select("consumed")
			.where("user_id", "=", USER)
			.executeTakeFirstOrThrow();
		expect(credit.consumed).toBe(0);
		expect(
			chunks.find((c) => c.type === "data-credit-refund")?.data,
		).toMatchObject({ amount: CREDITS_PER_BUILD });
		expect(wire).toContain('"type":"internal"');

		/* The failed turn clawed back to its pre-run state. */
		const thread = await threadRow();
		expect(thread.active_stream_id).toBeNull();
		expect((thread.messages as { role: string }[]).map((m) => m.role)).toEqual([
			"user",
		]);
	}, 30_000);

	it("a pre-app orchestration throw refunds the session hold and signals the refund", async () => {
		runBuildOrchestrationMock.mockImplementation(async (args) => {
			args.writer.write({ type: "start", messageId: args.responseMessageId });
			throw new Error("orchestration infrastructure fault");
		});

		const response = await POST(buildRequest());
		expect(response.status).toBe(200);
		const wire = await responseText(response);
		const chunks = wireChunks(wire);

		/* Same settle + refund as the typed failed outcome — and the same
		 * on-wire reassurance. The throw arm used to refund server-side but
		 * never emit `data-credit-refund`, so the person saw only the error
		 * and reasonably believed they paid for the turn that threw. */
		const session = await sessionRow();
		expect(session.state).toBe("active");
		expect(session.run_id).toBeNull();
		expect(session.res_settled).toBeNull();
		expect(session.res_reserved).toBeNull();
		const credit = await appDb
			.selectFrom("credit_months")
			.select("consumed")
			.where("user_id", "=", USER)
			.executeTakeFirstOrThrow();
		expect(credit.consumed).toBe(0);
		expect(
			chunks.find((c) => c.type === "data-credit-refund")?.data,
		).toMatchObject({ amount: CREDITS_PER_BUILD });
		expect(wire).toContain('"type":"internal"');
	}, 30_000);

	it("a completed build lands data-app-materialized before data-done and settles under the transferred holder", async () => {
		runBuildOrchestrationMock.mockImplementation(async (args) => {
			args.writer.write({ type: "start", messageId: args.responseMessageId });
			const receipt = await materializeDesignFixture({
				actorUserId: USER,
				projectId: PROJECT,
				appId: args.proposedAppId,
				runId: args.runId,
				holderNonce: args.holderNonce,
				designSessionId: args.designSessionId,
			});
			args.writer.write({
				type: "data-app-materialized",
				data: receipt,
				transient: true,
			});
			const finalized = await args.finalizeCompletion({
				appId: args.proposedAppId,
				expectedSeq: 1,
				expectedHead: null,
			});
			args.writer.write({ type: "finish" });
			return {
				kind: "completed",
				appId: args.proposedAppId,
				finalSeq: 1,
				finalBlueprint: finalized.blueprint,
			};
		});

		const response = await POST(buildRequest());
		expect(response.status).toBe(200);
		const wire = await responseText(response);
		const chunks = wireChunks(wire);

		/* The finishing order on the wire: scope announce → materialization
		 * receipt → the final canonical snapshot. */
		const types = chunks.map((c) => c.type);
		const announceAt = types.indexOf("data-design-session");
		const materializedAt = types.indexOf("data-app-materialized");
		const doneAt = types.indexOf("data-done");
		expect(announceAt).toBeGreaterThanOrEqual(0);
		expect(materializedAt).toBeGreaterThan(announceAt);
		expect(doneAt).toBeGreaterThan(materializedAt);

		/* The transferred holder settled: app completion, the kept charge, and
		 * the terminal orchestration event committed as one final decision. */
		const session = await sessionRow();
		const app = await appDb
			.selectFrom("apps")
			.select(["id", "status", "res_settled", "run_id"])
			.where("id", "=", session.app_id ?? "")
			.executeTakeFirstOrThrow();
		const canonical = await loadApp(app.id);
		expect(canonical).not.toBeNull();
		const materialized = chunks.find(
			(chunk) => chunk.type === "data-app-materialized",
		)?.data;
		expect(materialized).toMatchObject({
			eventVersion: 1,
			designSessionId: session.id,
			appId: app.id,
			projectId: PROJECT,
			canEdit: true,
			seq: 1,
			batchId: `genesis:${app.id}`,
			blueprint: canonical?.blueprint,
		});
		const baseline = await appDb
			.selectFrom("app_change_fold_baselines")
			.select(["seq", "project_id", "snapshot_digest"])
			.where("app_id", "=", app.id)
			.executeTakeFirstOrThrow();
		expect(materialized).toMatchObject({
			seq: Number(baseline.seq),
			projectId: baseline.project_id,
		});
		const committedSlice = await appDb
			.selectFrom("design_committed_slices")
			.select(["change_set_id", "committed_snapshot_digest"])
			.where("app_id", "=", app.id)
			.executeTakeFirstOrThrow();
		expect(materialized).toMatchObject({
			snapshotDigest: committedSlice.committed_snapshot_digest,
		});
		expect(
			await readMaterializedGenesisReceipt({
				changeSetId: committedSlice.change_set_id,
				actorUserId: USER,
			}),
		).toEqual(materialized);
		expect(app.status).toBe("complete");
		expect(app.res_settled).toBe(true);
		const terminal = await appDb
			.selectFrom("design_orchestration_events")
			.select(["kind", "run_id"])
			.where("design_session_id", "=", session.id)
			.orderBy("revision", "desc")
			.executeTakeFirstOrThrow();
		expect(terminal).toEqual({ kind: "finished", run_id: app.run_id });
		const credit = await appDb
			.selectFrom("credit_months")
			.select("consumed")
			.where("user_id", "=", USER)
			.executeTakeFirstOrThrow();
		expect(credit.consumed).toBe(CREDITS_PER_BUILD);

		/* The thread stays SESSION-targeted after materialization — one
		 * transcript lineage — with its marker retired by the clean finish. */
		const thread = await threadRow();
		expect(thread.design_session_id).toBe(session.id);
		expect(thread.app_id).toBeNull();
		expect(thread.active_stream_id).toBeNull();
	}, 30_000);
	it("an orchestration throw after materialization preserves the app and refunds its transferred reservation", async () => {
		runBuildOrchestrationMock.mockImplementation(async (args) => {
			args.writer.write({ type: "start", messageId: args.responseMessageId });
			const receipt = await materializeDesignFixture({
				actorUserId: USER,
				projectId: PROJECT,
				appId: args.proposedAppId,
				runId: args.runId,
				holderNonce: args.holderNonce,
				designSessionId: args.designSessionId,
			});
			args.writer.write({
				type: "data-app-materialized",
				data: receipt,
				transient: true,
			});
			throw new Error("Failure after the canonical transfer");
		});
		const response = await POST(buildRequest());
		expect(response.status).toBe(200);
		const chunks = wireChunks(await responseText(response));
		const session = await sessionRow();
		expect(session.app_id).toEqual(expect.any(String));
		const app = await appDb
			.selectFrom("apps")
			.selectAll()
			.where("id", "=", session.app_id ?? "")
			.executeTakeFirstOrThrow();
		expect(await loadApp(app.id)).not.toBeNull();
		expect(app.status).toBe("error");
		expect(app.error_type).toBe("internal");
		expect(app.res_settled).toBe(true);
		expect(app.lock_run_id).toBeNull();
		expect(session.res_settled).toBeNull();
		const credit = await appDb
			.selectFrom("credit_months")
			.select("consumed")
			.where("user_id", "=", USER)
			.executeTakeFirstOrThrow();
		expect(credit.consumed).toBe(0);
		expect(
			chunks.find((chunk) => chunk.type === "data-credit-refund")?.data,
		).toMatchObject({ amount: CREDITS_PER_BUILD });
		expect(chunks.some((chunk) => chunk.type === "data-done")).toBe(false);
		const thread = await threadRow();
		expect(thread.design_session_id).toBe(session.id);
		expect(thread.active_stream_id).toBeNull();
	});
});
