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

import type { Insertable, Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { canonicalTestBlueprint } from "@/lib/db/__tests__/appStateTestDb";
import {
	createPerTestAppDb,
	type PerTestAppDb,
} from "@/lib/db/__tests__/perTestAppDb";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import { CREDITS_PER_BUILD } from "@/lib/db/creditPolicy";
import { getCurrentPeriod } from "@/lib/db/period";
import { __setAppDbForTests, type AppDatabase } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";

const {
	resolveOpenAIKeyMock,
	resolveActiveProjectIdMock,
	resolveProjectAccessMock,
	projectRoleForInTransactionMock,
	createSolutionsArchitectMock,
	runBuildOrchestrationMock,
} = vi.hoisted(() => ({
	resolveOpenAIKeyMock: vi.fn(),
	resolveActiveProjectIdMock: vi.fn(),
	resolveProjectAccessMock: vi.fn(),
	projectRoleForInTransactionMock: vi.fn(),
	createSolutionsArchitectMock: vi.fn(),
	runBuildOrchestrationMock: vi.fn(),
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
vi.mock("@/lib/db/appAccess", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/appAccess")>()),
	AppAccessError: MockAppAccessError,
	resolveProjectAccess: resolveProjectAccessMock,
}));
vi.mock("@/lib/db/projectMembership", () => ({
	projectRoleForInTransaction: projectRoleForInTransactionMock,
}));
vi.mock("@/lib/agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/agent")>()),
	createSolutionsArchitect: createSolutionsArchitectMock,
}));
vi.mock("@/lib/agent/build/orchestrator", () => ({
	runBuildOrchestration: runBuildOrchestrationMock,
}));
/* Case-store schema convergence is exercised by its own integration suite;
 * here it must simply be awaited before the settle (the order pin below). */
vi.mock("@/lib/db/materializeCaseStoreSchemas", () => ({
	materializeCaseStoreSchemas: vi.fn(async () => undefined),
}));

const { POST } = await import("../route");

const USER = "user-design-1";
const PROJECT = "project-design-1";
const THREAD = "thread-design-1";

const dbHandle = setupPerTestDatabase({ databaseNamePrefix: "chat_design_" });

let appDb: Kysely<AppDatabase>;
let harness: PerTestAppDb;

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

/** Simulate materialization the way production's genesis transfer leaves the
 *  rows: an app row carrying the run's holder + reservation, the persisted
 *  blueprint entities, and the session flipped to `materialized` with its
 *  authority cleared. */
async function transferMaterializedApp(args: {
	appId: string;
	runId: string;
	holderNonce: string;
	designSessionId: string;
}): Promise<void> {
	const persisted = toPersistableDoc(
		canonicalTestBlueprint(args.appId, "Materialized design app"),
	);
	const formCount = persisted.moduleOrder.reduce(
		(sum, moduleUuid) => sum + (persisted.formOrder[moduleUuid]?.length ?? 0),
		0,
	);
	await appDb.transaction().execute(async (tx) => {
		await tx
			.insertInto("apps")
			.values({
				id: args.appId,
				owner: USER,
				project_id: PROJECT,
				app_name: persisted.appName,
				app_name_lower: persisted.appName.toLowerCase(),
				connect_type: persisted.connectType,
				case_types: null,
				logo: null,
				module_count: persisted.moduleOrder.length,
				form_count: formCount,
				mutation_seq: 1,
				status: "generating",
				awaiting_input: false,
				error_type: null,
				deleted_at: null,
				recoverable_until: null,
				run_id: args.runId,
				run_holder_nonce: args.holderNonce,
				res_period: getCurrentPeriod(),
				res_reserved: CREDITS_PER_BUILD,
				res_settled: false,
				res_user_id: USER,
				res_run_id: args.runId,
				lock_run_id: null,
				lock_actor_user_id: null,
				lock_expire_at: null,
			} satisfies Insertable<AppDatabase["apps"]>)
			.execute();
		await tx
			.insertInto("blueprint_entities")
			.values(
				decomposeBlueprint(persisted).map((row) => ({
					app_id: args.appId,
					uuid: row.uuid,
					kind: row.kind,
					parent_uuid: row.parent_uuid,
					ordinal: row.ordinal,
					data: JSON.stringify(row.data),
				})),
			)
			.execute();
		await tx
			.updateTable("design_sessions")
			.set({
				state: "materialized",
				app_id: args.appId,
				run_id: null,
				run_holder_nonce: null,
				run_actor_user_id: null,
				run_mode: null,
				run_lease_expires_at: null,
				res_period: null,
				res_reserved: null,
				res_settled: null,
				res_user_id: null,
				res_run_id: null,
			})
			.where("id", "=", args.designSessionId)
			.execute();
	});
}

beforeEach(async () => {
	await runCaseStoreMigrations(dbHandle.db);
	harness = createPerTestAppDb(dbHandle.uri);
	appDb = harness.appDb;
	__setAppDbForTests(appDb);

	resolveOpenAIKeyMock.mockReset();
	resolveActiveProjectIdMock.mockReset();
	resolveProjectAccessMock.mockReset();
	projectRoleForInTransactionMock.mockReset();
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
	resolveActiveProjectIdMock.mockResolvedValue(PROJECT);
	resolveProjectAccessMock.mockResolvedValue({
		projectId: PROJECT,
		role: "editor",
	});
	projectRoleForInTransactionMock.mockResolvedValue("editor");

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

afterEach(async () => {
	__setAppDbForTests(null);
	await harness.destroy();
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
			return { kind: "awaiting-input", pauseOwned: true };
		});
		const first = await POST(buildRequest());
		expect(first.status).toBe(200);
		await first.text();
		const before = await threadRow();

		await appDb
			.insertInto("design_sessions")
			.values({
				id: "52ac7038-bf76-4cb0-9f82-374609c7652a",
				mode: "build",
				project_id: PROJECT,
				owner_user_id: "other-project-member",
				proposed_app_id: "private-proposed-app",
				app_id: null,
				state: "active",
				awaiting_input: false,
			})
			.execute();

		/* THREAD belongs to the first session. The private-session admission must
		 * win before that mismatch can produce the thread guard's distinct 400. */
		const denied = await POST(
			buildRequest({
				designSessionId: "52ac7038-bf76-4cb0-9f82-374609c7652a",
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
			return { kind: "awaiting-input", pauseOwned: true };
		});

		const response = await POST(buildRequest());
		expect(response.status).toBe(200);
		const streamId = response.headers.get("x-workflow-run-id");
		const wire = await response.text();
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
		const wire = await response.text();
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

	it("a completed build lands data-app-materialized before data-done and settles under the transferred holder", async () => {
		runBuildOrchestrationMock.mockImplementation(async (args) => {
			args.writer.write({ type: "start", messageId: args.responseMessageId });
			await transferMaterializedApp({
				appId: args.proposedAppId,
				runId: args.runId,
				holderNonce: args.holderNonce,
				designSessionId: args.designSessionId,
			});
			args.writer.write({
				type: "data-app-materialized",
				data: { appId: args.proposedAppId, seq: 1 },
				transient: true,
			});
			args.writer.write({ type: "finish" });
			return { kind: "completed", appId: args.proposedAppId, finalSeq: 1 };
		});

		const response = await POST(buildRequest());
		expect(response.status).toBe(200);
		const wire = await response.text();
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

		/* The transferred holder settled: the app is complete with the kept
		 * charge booked, exactly the build finalize order. */
		const session = await sessionRow();
		const app = await appDb
			.selectFrom("apps")
			.select(["id", "status", "res_settled", "run_id"])
			.where("id", "=", session.app_id ?? "")
			.executeTakeFirstOrThrow();
		expect(app.status).toBe("complete");
		expect(app.res_settled).toBe(true);
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
});
