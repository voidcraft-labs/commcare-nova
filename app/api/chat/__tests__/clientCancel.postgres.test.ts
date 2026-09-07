/**
 * The chat POST against a real Postgres testcontainer: pinning the one
 * contract the whole resumable-threads design hangs on: **a client that
 * disconnects mid-run changes NOTHING server-side.**
 *
 * The regression this exists for: `createUIMessageStream`'s `onEnd` fires
 * through the response stream's `cancel()` hook as well as its natural end,
 * so teardown hung off it ran the moment a user refreshed mid-run, sealing
 * the chunk log with a synthetic `finish` (every later chunk dropped, the
 * resume replayed a truncated stub), flushing a zero-usage accumulator
 * (refunding the charge and latching the real finalize into a no-op), and
 * leaving the app stranded `generating` because `completeAndSettleRun`'s
 * ownership gate no longer matched. The route now runs its safety net in
 * execute's own `finally`, which cannot run before the body settles.
 *
 * The real Solutions Architect and installed AI SDK talk to a loopback
 * Responses HTTP peer. The peer controls provider output and timing;
 * tool validation, execution, usage, pause observers and UI barriers remain
 * production code. Canonical genesis and migrated Better Auth membership
 * establish the app and Project access. Only signed-in identity, provider
 * destination and named persistence fault points are controlled.
 * Build-mode admission uses a typed orchestrator outcome boundary; complete
 * design-turn materialization is exercised in designBuild.postgres.test.ts.
 *
 * The "barrier persistence" describe pins the record-as-produced contract on
 * the same harness: each completed step lands in the thread at its own
 * barrier (with its chunks durable in the log FIRST), a failed turn claws
 * back to its pre-run state (and keeps its marker when even the claw-back
 * cannot land, so recovery can trim the partial), a bailed POST leaves the
 * owning run's thread alone, a clean-release fault preserves the finished answer
 * and leaves its exact-holder charge for the reaper, a completed BUILD whose marker
 * retirement cannot land projects retired rather than interrupted (no
 * phantom re-drive), and the incident-shaped delta flood never reaches the
 * log.
 */

import type { UIMessageChunk } from "ai";
import type { Insertable, Kysely } from "kysely";
import { beforeEach, describe, expect, it as test, vi } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { withResponsesPeer } from "@/lib/agent/__tests__/responsesPeer";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

import {
	prepareGenesisCandidate,
	writePreparedGenesisInTransaction,
} from "@/lib/db/appGenesis";
import { CREDITS_PER_BUILD, CREDITS_PER_EDIT } from "@/lib/db/creditPolicy";
import { getCurrentPeriod } from "@/lib/db/period";
import type { AppDatabase } from "@/lib/db/pg";
import { canonicalAppGenesis, emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { ChatResponsesPeer } from "./chatResponsesPeer";

const {
	providerTransport,
	resolveOpenAIKeyMock,
	resolveAuthorizedAppSnapshotMock,
	createSolutionsArchitectMock,
	runBuildOrchestrationMock,
	claimAndReserveRunMock,
	reacquireLeaseMock,
	setAwaitingInputMock,
	clearRunLockMock,
	clearRunLockAndSettleMock,
	completeAndSettleRunMock,
	failAppMock,
	refundReservationMock,
	settleAndReleaseMock,
	failClearMarkerWrites,
	failClawBackWrites,
} = vi.hoisted(() => ({
	providerTransport: {
		current: undefined as typeof globalThis.fetch | undefined,
	},
	resolveOpenAIKeyMock: vi.fn(),
	resolveAuthorizedAppSnapshotMock: vi.fn(),
	createSolutionsArchitectMock: vi.fn(),
	runBuildOrchestrationMock:
		vi.fn<
			typeof import("@/lib/agent/build/orchestrator").runBuildOrchestration
		>(),
	claimAndReserveRunMock: vi.fn(),
	reacquireLeaseMock: vi.fn(),
	setAwaitingInputMock: vi.fn(),
	clearRunLockMock: vi.fn(),
	clearRunLockAndSettleMock: vi.fn(),
	completeAndSettleRunMock: vi.fn(),
	failAppMock: vi.fn(),
	refundReservationMock: vi.fn(),
	settleAndReleaseMock: vi.fn(),
	/* Fault injector for the stranded-marker tests: while `on`, every
	 * marker-retiring thread write (`clearMarker: true`) fails — the fold's
	 * terminal write AND finalize's fallback — leaving a completed run's
	 * marker stranded. */
	failClearMarkerWrites: { on: false },
	/* Its claw-back sibling: while `on`, every `clawBackThreadResponse` write
	 * fails, so a failed turn's terminal write can never land and the
	 * fallback's stranded-marker arm is what's under test. */
	failClawBackWrites: { on: false },
}));

vi.mock("@/lib/auth-utils", () => ({
	resolveOpenAIKey: resolveOpenAIKeyMock,
}));
vi.mock("@/lib/db/appAccess", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/db/appAccess")>();
	resolveAuthorizedAppSnapshotMock.mockImplementation(
		actual.resolveAuthorizedAppSnapshot,
	);
	return {
		...actual,
		resolveAuthorizedAppSnapshot: resolveAuthorizedAppSnapshotMock,
	};
});
/* New-app creation reauthorizes against the membership row inside the same
 * transaction as the insert. This route test deliberately mocks auth + Project
 * access, so grant that transactional seam explicitly as well. Its locking and
 * denial behavior are covered by the authoritative-writer integration suites. */

/* Keep the route integration on the real lifecycle writers, but expose the
 * ownership-sensitive calls as pass-through spies. The resume regression can
 * then force only the lease re-acquire read to fail and prove that the route
 * does not infer ownership strongly enough to settle/refund/release anything. */
vi.mock("@/lib/db/apps", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/db/apps")>();
	claimAndReserveRunMock.mockImplementation(actual.claimAndReserveRun);
	reacquireLeaseMock.mockImplementation(actual.reacquireLease);
	setAwaitingInputMock.mockImplementation(actual.setAwaitingInput);
	clearRunLockMock.mockImplementation(actual.clearRunLock);
	clearRunLockAndSettleMock.mockImplementation(actual.clearRunLockAndSettle);
	completeAndSettleRunMock.mockImplementation(actual.completeAndSettleRun);
	failAppMock.mockImplementation(actual.failApp);
	return {
		...actual,
		claimAndReserveRun: claimAndReserveRunMock,
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
/* The provider destination is the only model replacement. The real SA,
 * ToolLoopAgent, schemas, workspace and step observer all execute. */
vi.mock("@/lib/agent/openaiProvider", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/agent/openaiProvider")>();
	return {
		...actual,
		createNovaOpenAI: (apiKey: string, transport?: typeof globalThis.fetch) => {
			if (!transport && !providerTransport.current)
				throw new Error("Model peer is not installed");
			return actual.createNovaOpenAI(
				apiKey,
				transport ?? providerTransport.current,
			);
		},
	};
});
vi.mock("@/lib/agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/agent")>();
	createSolutionsArchitectMock.mockImplementation(
		actual.createSolutionsArchitect,
	);
	return { ...actual, createSolutionsArchitect: createSolutionsArchitectMock };
});
/* The build orchestrator is a module seam: a design-session turn never
 * mounts the SA, and the real orchestrator would drive the design pipeline
 * (live model calls). Tests that exercise a BUILD-shaped claim configure
 * this mock per test; the unconfigured default throws so an accidental
 * design-turn invocation fails loudly instead of reaching the network. */
vi.mock("@/lib/agent/build/orchestrator", () => ({
	runBuildOrchestration: runBuildOrchestrationMock,
}));
/* Runtime schemas run on this test's actual migrated database. */

/* Real thread persistence, with one injectable fault: the honesty test flips
 * `failClearMarkerWrites.on` so every marker-retiring write fails while the
 * per-barrier writes keep landing. */
vi.mock("@/lib/db/threads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/db/threads")>();
	return {
		...actual,
		persistResponseSnapshot: async (
			args: Parameters<typeof actual.persistResponseSnapshot>[0],
		) => {
			if (failClearMarkerWrites.on && args.clearMarker) {
				throw new Error("thread write connection dropped");
			}
			return actual.persistResponseSnapshot(args);
		},
		clawBackThreadResponse: async (
			args: Parameters<typeof actual.clawBackThreadResponse>[0],
		) => {
			if (failClawBackWrites.on) {
				throw new Error("thread write connection dropped");
			}
			return actual.clawBackThreadResponse(args);
		},
	};
});

const { POST } = await import("../route");

const USER = "user-cancel-1";
const PROJECT = "project-cancel-1";
const THREAD = "thread-cancel-1";
const RESUME_APP = "app-resume-reacquire-error";
const RESUME_RUN = "run-resume-reacquire-error";
const RESUME_THREAD = "thread-resume-reacquire-error";
const RESERVATION_PERIOD = "2026-07";
const WAIT_APP = "app-serialize-wait-snapshot";
const WAIT_THREAD = "thread-serialize-wait-snapshot";
const MOVED_PROJECT = "project-after-serialize-wait";
const REPLACEMENT_NONCE = "00000000-0000-4000-8000-000000000099";
const PAUSED_BUILD_APP = "app-paused-build-mode";
const PAUSED_BUILD_RUN = "run-paused-build-mode";
const PAUSED_BUILD_THREAD = "thread-paused-build-mode";
const ADOPT_APP = "app-serialize-wait-adopt";
const ADOPT_THREAD = "thread-serialize-wait-adopt";
const FASTFAIL_APP = "app-fastfail-build-rate";
const DIRECT_ADOPT_APP = "app-direct-adopt-readmit";
const DIRECT_ADOPT_THREAD = "thread-direct-adopt-readmit";
const WAITFAIL_APP = "app-wait-adopt-summary";
const WAITFAIL_THREAD = "thread-wait-adopt-summary";
const MEMBER = "user-cancel-member";
const FEED_APP = "app-feed-edit";
const PAUSED_BUILD_SESSION = "00000000-0000-4000-8000-0000000000d1";
const ADOPT_SESSION = "00000000-0000-4000-8000-0000000000d2";
const FASTFAIL_SESSION = "00000000-0000-4000-8000-0000000000d3";
const DIRECT_ADOPT_SESSION = "00000000-0000-4000-8000-0000000000d4";
const WAITFAIL_SESSION = "00000000-0000-4000-8000-0000000000d5";

const h = setupAppStateTestDb("chat_clientcancel_", {
	authSchema: "migrated",
	poolMax: 4,
});

let appDb: Kysely<AppDatabase>;

let peer: ChatResponsesPeer;
const responseBodies = new Set<Promise<string>>();
const responseStreams = new Set<string>();
const originalPOST = POST;

/** Every test owns its provider sockets and every response body it starts.
 * Closing a held provider response in finally lets the route finish even when
 * a mid-stream assertion fails; the body/terminal log joins precede DB teardown. */
function it(name: string, run: () => Promise<void>, timeout = 30_000): void {
	test(
		name,
		async () => {
			peer = new ChatResponsesPeer();
			await withResponsesPeer(peer.handle, async (_provider, transport) => {
				providerTransport.current = transport;
				let bodyFailures: unknown[] = [];
				try {
					await run();
					peer.assertHealthy();
				} finally {
					peer.close();
					const bodies = await Promise.allSettled(responseBodies);
					bodyFailures = bodies
						.filter((body) => body.status === "rejected")
						.map((body) => body.reason);
					for (const streamId of responseStreams) {
						await pollFor(async () =>
							(await chunkRows(streamId)).some((row) => row.terminal)
								? true
								: undefined,
						);
					}
					responseBodies.clear();
					responseStreams.clear();
					providerTransport.current = undefined;
				}
				if (bodyFailures.length > 0)
					throw new AggregateError(bodyFailures, "POST response bodies failed");
			});
		},
		timeout,
	);
}

async function post(request: Request): Promise<Response> {
	const response = await originalPOST(request);
	const streamId = response.headers.get("x-workflow-run-id");
	if (streamId) responseStreams.add(streamId);
	return response;
}
function responseText(response: Response): Promise<string> {
	const body = response.text();
	responseBodies.add(body);
	return body;
}

/** Seed the canonical complete app used by real SA edit turns. */
async function seedFeedEditApp() {
	return seedSnapshotApp({ id: FEED_APP, name: "Feed edit app" });
}

/** Insert a materialized design session bound to `appId` — the orchestration
 *  scope every non-complete app must carry after the cutover (a sessionless
 *  one is a legacy row the route refuses pending repair). */
async function seedBoundSession(sessionId: string, appId: string) {
	await appDb
		.insertInto("design_sessions")
		.values({
			id: sessionId,
			mode: "build",
			project_id: PROJECT,
			owner_user_id: USER,
			proposed_app_id: appId,
			app_id: appId,
			state: "materialized",
			awaiting_input: false,
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
			last_error_type: null,
			active_design_revision_id: null,
			active_build_plan_id: null,
			created_at: new Date(),
			updated_at: new Date(),
		})
		.execute();
}

function editTurnRequest(): Request {
	return new Request("http://localhost/api/chat", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			appId: FEED_APP,
			appReady: true,
			threadId: THREAD,
			messages: [
				{
					id: "u1",
					role: "user",
					parts: [{ type: "text", text: "add a status field" }],
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

function waitingEditRequest(): Request {
	return new Request("http://localhost/api/chat", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			appId: WAIT_APP,
			appReady: true,
			threadId: WAIT_THREAD,
			messages: [
				{
					id: "waiting-edit-user",
					role: "user",
					parts: [{ type: "text", text: "Add a clinic status field." }],
				},
			],
		}),
	});
}

/** Emit a schema-valid client-side tool through the real provider parser. */
function configurePausedAgent(): void {
	const response = peer.response();
	response.tool(
		"askQuestions",
		{
			header: "Clinics",
			questions: [
				{
					question: "Which clinics should I include?",
					options: [
						{ label: "All district clinics" },
						{ label: "Selected clinics" },
					],
				},
			],
		},
		{ callId: "pause-question" },
	);
	response.finish();
}

async function expectNoResumablePause(response: Response, errorType: string) {
	expect(response.status).toBe(200);
	const wire = await responseText(response);
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
	return app;
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
		.select(["first_index", "chunks", "terminal", "terminal_outcome"])
		.where("stream_id", "=", streamId)
		.orderBy("first_index", "asc")
		.execute();
}

async function seedCanonicalApp(args: {
	id: string;
	name: string;
	overrides?: Partial<Insertable<AppDatabase["apps"]>>;
}): Promise<void> {
	const genesis = canonicalAppGenesis(emptyBlueprintDoc(args.id), args.name);
	const candidate = prepareGenesisCandidate({
		appId: args.id,
		projectId: PROJECT,
		mutations: genesis.mutations,
	});
	await appDb.transaction().execute(async (tx) => {
		await writePreparedGenesisInTransaction(tx, {
			candidate,
			actorUserId: USER,
			runId: "fixture-birth",
			status: "complete",
		});
	});
	// Birth commits with its exact run identity before this fixture models a later lifecycle state.
	if (args.overrides)
		await appDb
			.updateTable("apps")
			.set(args.overrides)
			.where("id", "=", args.id)
			.execute();
}

type LoadedFixtureApp = NonNullable<
	Awaited<ReturnType<typeof import("@/lib/db/apps")["loadApp"]>>
>;

/** The authorized-snapshot shape the route destructures, built from a loaded
 *  app row. One builder so a new snapshot field lands in every test at once. */
function snapshotFor(app: LoadedFixtureApp) {
	return {
		app,
		projectId: PROJECT,
		role: "editor" as const,
		canEdit: true,
		baseSeq: app.mutation_seq,
		actorUserId: USER,
	};
}

/** Seed canonical persistence and return the actual loaded snapshot. */
async function seedSnapshotApp(args: {
	id: string;
	name: string;
	overrides?: Partial<Insertable<AppDatabase["apps"]>>;
}) {
	await seedCanonicalApp({
		id: args.id,
		name: args.name,
		overrides: args.overrides,
	});
	const { loadApp } = await import("@/lib/db/apps");
	const app = await loadApp(args.id);
	if (!app) throw new Error(`fixture app ${args.id} was not persisted`);
	const snapshot = snapshotFor(app);

	return { app, snapshot };
}

async function seedSerializeWaitEdit() {
	await seedCanonicalApp({ id: WAIT_APP, name: "Waited edit app" });

	const actualApps =
		await vi.importActual<typeof import("@/lib/db/apps")>("@/lib/db/apps");
	const actualAccess =
		await vi.importActual<typeof import("@/lib/db/appAccess")>(
			"@/lib/db/appAccess",
		);
	const initialSnapshot = await actualAccess.resolveAuthorizedAppSnapshot(
		WAIT_APP,
		USER,
		"edit",
	);
	resolveAuthorizedAppSnapshotMock.mockResolvedValueOnce(initialSnapshot);
	const priorRun = "other-member-wait-holder";
	await actualApps.claimAndReserveRun(
		WAIT_APP,
		"edit",
		priorRun,
		MEMBER,
		CREDITS_PER_EDIT,
		PROJECT,
		REPLACEMENT_NONCE,
	);
	// The route's first actual claim observes this live holder. The other
	// member then completes, so the route's waiting poll can own the next claim.
	claimAndReserveRunMock.mockImplementationOnce(
		async (...args: Parameters<typeof actualApps.claimAndReserveRun>) => {
			try {
				return await actualApps.claimAndReserveRun(...args);
			} finally {
				await actualApps.clearRunLockAndSettle(
					WAIT_APP,
					priorRun,
					REPLACEMENT_NONCE,
				);
			}
		},
	);
	return initialSnapshot;
}

async function expectSerializeWaitSnapshotFailure(errorType: string) {
	const response = await post(waitingEditRequest());
	expect(response.status).toBe(200);
	const wire = await responseText(response);
	expect(wire).toContain(`"type":"${errorType}"`);
	expect(wire).toContain('"type":"data-credit-refund"');
	expect(createSolutionsArchitectMock).not.toHaveBeenCalled();
	expect(claimAndReserveRunMock).toHaveBeenCalledTimes(2);
	expect(resolveAuthorizedAppSnapshotMock).toHaveBeenNthCalledWith(
		1,
		WAIT_APP,
		USER,
		"edit",
	);
	expect(resolveAuthorizedAppSnapshotMock).toHaveBeenNthCalledWith(
		2,
		WAIT_APP,
		USER,
		"edit",
	);

	const app = await appDb
		.selectFrom("apps")
		.select([
			"status",
			"error_type",
			"res_reserved",
			"res_settled",
			"lock_run_id",
			"lock_actor_user_id",
		])
		.where("id", "=", WAIT_APP)
		.executeTakeFirstOrThrow();
	expect(app).toEqual({
		status: "complete",
		error_type: null,
		res_reserved: 5,
		res_settled: true,
		lock_run_id: null,
		lock_actor_user_id: null,
	});
	const credit = await appDb
		.selectFrom("credit_months")
		.select("consumed")
		.where("user_id", "=", USER)
		.executeTakeFirstOrThrow();
	expect(credit.consumed).toBe(0);
	expect(settleAndReleaseMock).toHaveBeenCalledTimes(1);
	expect(failAppMock).not.toHaveBeenCalled();
}

beforeEach(async () => {
	appDb = h.db();
	await h.seedProjectMember(USER, PROJECT);
	await h.seedProjectMember(MEMBER, PROJECT);

	resolveOpenAIKeyMock.mockReset();
	resolveAuthorizedAppSnapshotMock.mockReset();
	const actualAccess =
		await vi.importActual<typeof import("@/lib/db/appAccess")>(
			"@/lib/db/appAccess",
		);
	resolveAuthorizedAppSnapshotMock.mockImplementation(
		actualAccess.resolveAuthorizedAppSnapshot,
	);
	createSolutionsArchitectMock.mockClear();
	runBuildOrchestrationMock.mockReset();
	runBuildOrchestrationMock.mockRejectedValue(
		new Error("runBuildOrchestration invoked without a per-test configuration"),
	);
	const actualApps =
		await vi.importActual<typeof import("@/lib/db/apps")>("@/lib/db/apps");
	claimAndReserveRunMock
		.mockReset()
		.mockImplementation(actualApps.claimAndReserveRun);
	reacquireLeaseMock.mockReset().mockImplementation(actualApps.reacquireLease);
	setAwaitingInputMock
		.mockReset()
		.mockImplementation(actualApps.setAwaitingInput);
	clearRunLockMock.mockReset().mockImplementation(actualApps.clearRunLock);
	clearRunLockAndSettleMock
		.mockReset()
		.mockImplementation(actualApps.clearRunLockAndSettle);
	completeAndSettleRunMock
		.mockReset()
		.mockImplementation(actualApps.completeAndSettleRun);
	failAppMock.mockReset().mockImplementation(actualApps.failApp);
	refundReservationMock.mockClear();
	settleAndReleaseMock.mockClear();

	resolveOpenAIKeyMock.mockResolvedValue({
		ok: true,
		apiKey: "test-key",
		session: { user: { id: USER } },
	});
	failClearMarkerWrites.on = false;
	failClawBackWrites.on = false;
});

describe("mid-run client disconnect", () => {
	it("changes nothing server-side: the run streams on, finalizes once, and persists in full", async () => {
		await seedFeedEditApp();
		const model = peer.response();

		const response = await post(editTurnRequest());
		expect(response.status).toBe(200);
		const streamId = response.headers.get("x-workflow-run-id");
		expect(streamId).toBeTruthy();
		if (!streamId || !response.body) throw new Error("no stream to read");

		/* Stream the first half of the "model" output and read it off the live
		 * response, so the cancel below lands mid-run with bytes in flight:
		 * the exact shape of a user refreshing while reasoning streams. */
		model.text("Setting up your app");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let wire = "";
		try {
			while (!wire.includes("Setting up your app")) {
				const { done, value } = await reader.read();
				if (done) throw new Error("response ended before the first delta");
				wire += decoder.decode(value, { stream: true });
			}
		} finally {
			// Refresh cancels the browser reader while the provider stays open.
			await reader.cancel();
			reader.releaseLock();
		}

		/* Give any wrongly-wired teardown its chance to run, and the durable
		 * writer's 300 ms batch window time to land the pre-cancel chunks. */
		await pollFor(async () =>
			(await chunkRows(streamId)).length > 0 ? true : undefined,
		);

		/* Nothing terminal may exist while the run is still live: no sealed
		 * chunk log, no run summary (the premature zero-usage flush), and the
		 * edit's run_lock still held. */
		const midRows = await chunkRows(streamId);
		expect(midRows.some((row) => row.terminal)).toBe(false);
		const midSummaries = await appDb
			.selectFrom("run_summaries")
			.select(["run_id"])
			.execute();
		expect(midSummaries).toHaveLength(0);
		const midApp = await appDb
			.selectFrom("apps")
			.select(["status", "lock_run_id"])
			.where("owner", "=", USER)
			.executeTakeFirstOrThrow();
		expect(midApp.status).toBe("complete");
		expect(midApp.lock_run_id).not.toBeNull();

		/* The run finishes AFTER the client left. */
		model.text(" — done.");
		model.finish();

		/* The real finalize lands on the drain's terminal state: the edit's
		 * run_lock releases with the kept charge settled... */
		const app = await pollFor(async () => {
			const row = await appDb
				.selectFrom("apps")
				.select(["id", "status", "lock_run_id", "res_settled"])
				.where("owner", "=", USER)
				.executeTakeFirstOrThrow();
			return row.lock_run_id === null ? row : undefined;
		});
		expect(app.status).toBe("complete");
		expect(app.res_settled).toBe(true);

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
		expect(logged.filter((c) => c.type === "finish")).toEqual([
			expect.objectContaining({ type: "finish", finishReason: "stop" }),
		]);
		expect(rows.find((row) => row.terminal)?.terminal_outcome).toBe(
			"completed",
		);
		const credit = await appDb
			.selectFrom("credit_months")
			.select("consumed")
			.where("user_id", "=", USER)
			.where("period", "=", getCurrentPeriod())
			.executeTakeFirstOrThrow();
		expect(credit.consumed).toBe(CREDITS_PER_EDIT);

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
			.select(["run_id", "finished_at", "input_tokens", "output_tokens"])
			.execute();
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.finished_at).toBeTruthy();
		expect(Number(summaries[0]?.input_tokens)).toBe(10);
		expect(Number(summaries[0]?.output_tokens)).toBe(5);
	}, 30_000);
});

describe("serialize-with-wait authorized snapshot admission", () => {
	it("refunds and stops as access_revoked when membership disappears after the claim", async () => {
		await seedSerializeWaitEdit();
		resolveAuthorizedAppSnapshotMock.mockImplementationOnce(
			async (
				...args: Parameters<
					typeof import("@/lib/db/appAccess").resolveAuthorizedAppSnapshot
				>
			) => {
				const { getAuthDb } = await import("@/lib/auth/db");
				const authDb = await getAuthDb();
				await authDb
					.deleteFrom("auth_member")
					.where("userId", "=", USER)
					.where("organizationId", "=", PROJECT)
					.execute();
				const actualAccess =
					await vi.importActual<typeof import("@/lib/db/appAccess")>(
						"@/lib/db/appAccess",
					);
				return actualAccess.resolveAuthorizedAppSnapshot(...args);
			},
		);

		await expectSerializeWaitSnapshotFailure("access_revoked");
	}, 30_000);

	it("refunds and stops as app_changed instead of seeding from a different Project", async () => {
		const initial = await seedSerializeWaitEdit();
		resolveAuthorizedAppSnapshotMock.mockResolvedValueOnce({
			...initial,
			app: { ...initial.app, project_id: MOVED_PROJECT },
			projectId: MOVED_PROJECT,
		});

		await expectSerializeWaitSnapshotFailure("app_changed");
	}, 30_000);

	it("refunds and stops as internal when the post-claim snapshot read faults", async () => {
		await seedSerializeWaitEdit();
		resolveAuthorizedAppSnapshotMock.mockRejectedValueOnce(
			new Error("authorized snapshot connection dropped"),
		);

		await expectSerializeWaitSnapshotFailure("internal");
	}, 30_000);
});

describe("pause-stamp ownership admission", () => {
	it("ends as superseded without publishing a resumable pause when a replacement owns the app", async () => {
		await seedFeedEditApp();
		configurePausedAgent();
		const actualApps =
			await vi.importActual<typeof import("@/lib/db/apps")>("@/lib/db/apps");
		setAwaitingInputMock.mockImplementationOnce(
			async (...args: Parameters<typeof actualApps.setAwaitingInput>) => {
				await actualApps.clearRunLockAndSettle(args[0], args[1], args[2]);
				await actualApps.claimAndReserveRun(
					args[0],
					"edit",
					"replacement-run",
					USER,
					CREDITS_PER_EDIT,
					PROJECT,
					REPLACEMENT_NONCE,
				);
				return actualApps.setAwaitingInput(...args);
			},
		);

		const app = await expectNoResumablePause(
			await post(editTurnRequest()),
			"generation_in_progress",
		);

		expect(setAwaitingInputMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			expect.any(String),
			"edit",
			true,
			USER,
			PROJECT,
		);
		expect(app.status).toBe("complete");
		expect(app.res_run_id).toBe("replacement-run");
		expect(app.res_settled).toBe(false);
	}, 30_000);

	it("ends as released without publishing a resumable pause after the holder was reaped", async () => {
		await seedFeedEditApp();
		configurePausedAgent();
		const actualApps =
			await vi.importActual<typeof import("@/lib/db/apps")>("@/lib/db/apps");
		setAwaitingInputMock.mockImplementationOnce(
			async (...args: Parameters<typeof actualApps.setAwaitingInput>) => {
				await appDb
					.updateTable("apps")
					.set({ lock_expire_at: new Date(0) })
					.where("id", "=", args[0])
					.execute();
				const reaped = await actualApps.reapStaleRun(args[0], {
					mode: "edit",
					runId: args[1],
					nonce: args[2],
				});
				expect(reaped).toBe("reaped");
				return actualApps.setAwaitingInput(...args);
			},
		);

		const app = await expectNoResumablePause(
			await post(editTurnRequest()),
			"run_released",
		);

		expect(app.status).toBe("complete");
		expect(app.error_type).toBeNull();
		expect(app.res_settled).toBe(true);
		expect(app.lock_run_id).toBeNull();
	}, 30_000);

	it("takes the failure funnel when pause persistence faults instead of claiming a resumable pause", async () => {
		await seedFeedEditApp();
		configurePausedAgent();
		setAwaitingInputMock.mockRejectedValueOnce(
			new Error("pause write connection dropped"),
		);

		const app = await expectNoResumablePause(
			await post(editTurnRequest()),
			"internal",
		);

		/* A failed EDIT refunds and releases its lock but never flips the
		 * committed app's status. */
		expect(app.status).toBe("complete");
		expect(app.error_type).toBeNull();
		expect(app.res_settled).toBe(true);
		expect(app.lock_run_id).toBeNull();
	}, 30_000);
});

describe("free-continuation resume admission", () => {
	it("fails closed on an unexpected re-acquire error without touching the holder or its credits", async () => {
		await seedCanonicalApp({
			id: RESUME_APP,
			name: "Paused app",
			overrides: {
				awaiting_input: true,
				run_id: RESUME_RUN,
				run_holder_nonce: REPLACEMENT_NONCE,
				res_period: RESERVATION_PERIOD,
				res_reserved: 5,
				res_settled: false,
				res_user_id: USER,
				res_run_id: RESUME_RUN,
				lock_run_id: RESUME_RUN,
				lock_actor_user_id: USER,
				lock_expire_at: new Date(Date.now() + 60_000),
			},
		});
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
		await appDb
			.insertInto("threads")
			.values({
				thread_id: RESUME_THREAD,
				app_id: RESUME_APP,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				thread_type: "edit",
				summary: "Paused answer",
				run_id: RESUME_RUN,
				active_stream_id: null,
				active_holder_nonce: null,
				messages: JSON.stringify([]),
			})
			.execute();

		const { loadApp } = await import("@/lib/db/apps");
		const app = await loadApp(RESUME_APP);
		if (!app) throw new Error("resume fixture app was not persisted");
		resolveAuthorizedAppSnapshotMock.mockResolvedValue({
			app,
			projectId: PROJECT,
			role: "editor",
			canEdit: true,
			baseSeq: app.mutation_seq,
			actorUserId: USER,
		});
		reacquireLeaseMock.mockRejectedValueOnce(
			new Error("database connection dropped during resume admission"),
		);

		const response = await post(resumeChatRequest());
		expect(response.status).toBe(200);
		const wire = await responseText(response);

		expect(reacquireLeaseMock).toHaveBeenCalledWith(
			RESUME_APP,
			RESUME_RUN,
			null,
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

describe("server-derived build-vs-edit mode", () => {
	/** A real build claim and pause on the canonical app establish both the
	 * exact holder and its matching ledger before a browser answer resumes. */
	async function seedPausedBuild(): Promise<void> {
		await seedSnapshotApp({ id: PAUSED_BUILD_APP, name: "Paused build app" });
		const actualApps =
			await vi.importActual<typeof import("@/lib/db/apps")>("@/lib/db/apps");
		await actualApps.claimAndReserveRun(
			PAUSED_BUILD_APP,
			"build",
			PAUSED_BUILD_RUN,
			USER,
			CREDITS_PER_BUILD,
			PROJECT,
			REPLACEMENT_NONCE,
		);
		expect(
			await actualApps.setAwaitingInput(
				PAUSED_BUILD_APP,
				PAUSED_BUILD_RUN,
				REPLACEMENT_NONCE,
				"build",
				true,
				USER,
				PROJECT,
			),
		).toBe("owned");
		await seedBoundSession(PAUSED_BUILD_SESSION, PAUSED_BUILD_APP);
		await appDb
			.insertInto("threads")
			.values({
				thread_id: PAUSED_BUILD_THREAD,
				app_id: null,
				design_session_id: PAUSED_BUILD_SESSION,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				thread_type: "build",
				summary: "Paused build answer",
				run_id: PAUSED_BUILD_RUN,
				active_stream_id: null,
				active_holder_nonce: null,
				messages: JSON.stringify([]),
			})
			.execute();
	}

	function installOwnedBuildPause(): void {
		runBuildOrchestrationMock.mockImplementation(async (args) => {
			args.meter?.track({ inputTokens: 10, outputTokens: 5 });
			args.writer.write({ type: "start", messageId: args.responseMessageId });
			const actualApps =
				await vi.importActual<typeof import("@/lib/db/apps")>("@/lib/db/apps");
			const outcome = await actualApps.setAwaitingInput(
				PAUSED_BUILD_APP,
				args.runId,
				args.holderNonce,
				"build",
				true,
				USER,
				PROJECT,
			);
			args.writer.write({ type: "finish" });
			return { kind: "awaiting-input", pauseOwned: outcome === "owned" };
		});
	}
	async function expectOwnedBuildPause(runId: string): Promise<void> {
		const app = await appDb
			.selectFrom("apps")
			.select([
				"status",
				"awaiting_input",
				"run_id",
				"res_run_id",
				"res_reserved",
				"res_settled",
			])
			.where("id", "=", PAUSED_BUILD_APP)
			.executeTakeFirstOrThrow();
		expect(app).toEqual({
			status: "generating",
			awaiting_input: true,
			run_id: runId,
			res_run_id: runId,
			res_reserved: CREDITS_PER_BUILD,
			res_settled: false,
		});
		const credit = await appDb
			.selectFrom("credit_months")
			.select("consumed")
			.where("user_id", "=", USER)
			.where("period", "=", getCurrentPeriod())
			.executeTakeFirstOrThrow();
		expect(credit.consumed).toBe(CREDITS_PER_BUILD);
	}

	it("resumes a paused build's answer as a BUILD even when the client claims appReady", async () => {
		await seedPausedBuild();
		installOwnedBuildPause();

		const response = await post(
			new Request("http://localhost/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					/* The new-world answering tab names its design session; the
					 * bound app and the BUILD shape are the server's derivation. */
					designSessionId: PAUSED_BUILD_SESSION,
					appReady: true,
					threadId: PAUSED_BUILD_THREAD,
					runId: PAUSED_BUILD_RUN,
					holderNonce: REPLACEMENT_NONCE,
					messages: [
						{
							id: "paused-build-user",
							role: "user",
							parts: [{ type: "text", text: "Build a nutrition app." }],
						},
						{
							id: "paused-build-answer",
							role: "assistant",
							parts: [{ type: "text", text: "Questions answered." }],
						},
					],
				}),
			}),
		);

		expect(response.status).toBe(200);
		const wire = await responseText(response);
		expect(reacquireLeaseMock).toHaveBeenCalledWith(
			PAUSED_BUILD_APP,
			PAUSED_BUILD_RUN,
			REPLACEMENT_NONCE,
			"build",
			USER,
			PROJECT,
		);
		expect(createSolutionsArchitectMock).not.toHaveBeenCalled();
		expect(runBuildOrchestrationMock).toHaveBeenCalledOnce();
		expect(wire).not.toContain('"type":"run_released"');
		expect(claimAndReserveRunMock).not.toHaveBeenCalled();
		await expectOwnedBuildPause(PAUSED_BUILD_RUN);
	}, 30_000);

	it("claims a chargeable turn on a non-complete app as a BUILD at the build rate", async () => {
		await seedPausedBuild();
		installOwnedBuildPause();

		const response = await post(
			new Request("http://localhost/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					designSessionId: PAUSED_BUILD_SESSION,
					appReady: true,
					threadId: "thread-paused-build-chargeable",
					messages: [
						{
							id: "paused-build-new-instruction",
							role: "user",
							parts: [{ type: "text", text: "Start over with two modules." }],
						},
					],
				}),
			}),
		);

		expect(response.status).toBe(200);
		await responseText(response);
		expect(claimAndReserveRunMock).toHaveBeenCalledWith(
			PAUSED_BUILD_APP,
			"build",
			expect.any(String),
			USER,
			100,
			PROJECT,
			expect.any(String),
			{ requireModeMatchesStatus: true },
		);
		expect(createSolutionsArchitectMock).not.toHaveBeenCalled();
		expect(runBuildOrchestrationMock).toHaveBeenCalledOnce();
		const app = await appDb
			.selectFrom("apps")
			.select("run_id")
			.where("id", "=", PAUSED_BUILD_APP)
			.executeTakeFirstOrThrow();
		expect(app.run_id).not.toBe(PAUSED_BUILD_RUN);
		if (!app.run_id) throw new Error("The chargeable build has no holder");
		await expectOwnedBuildPause(app.run_id);
	}, 30_000);

	it("a serialize-wait whose awaited build completes adopts EDIT mode end to end: claim, run, and clean release", async () => {
		/* The TOCTOU this pins: the waiter derived BUILD (the app was
		 * `generating` when it queued) and the awaited build completed during
		 * the wait. The stale claim must reject (`ClaimModeStaleError`), the
		 * route must adopt the locked row's EDIT mode at the edit rate, and —
		 * the part a stale `GenerationContext` used to break — the run must
		 * FINALIZE as an edit: a context still presenting a build holder
		 * capability dies `RunHolderLostError` on its first ownership-gated
		 * write and strands the real `run_lock` this POST took. */
		await seedSnapshotApp({
			id: ADOPT_APP,
			name: "Adopted edit app",
			overrides: {
				status: "generating",
				run_id: "run-other-build",
				run_holder_nonce: REPLACEMENT_NONCE,
				res_period: RESERVATION_PERIOD,
				res_reserved: 100,
				res_settled: false,
				res_user_id: MEMBER,
				res_run_id: "run-other-build",
			},
		});
		await seedBoundSession(ADOPT_SESSION, ADOPT_APP);
		const rename = peer.response();
		rename.tool("updateApp", { name: "Adopted edit rename" });
		rename.finish();
		const renamed = peer.response();
		renamed.text("Renamed the app.");
		renamed.finish();

		const response = await post(
			new Request("http://localhost/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					appId: ADOPT_APP,
					threadId: ADOPT_THREAD,
					messages: [
						{
							id: "adopt-user",
							role: "user",
							parts: [{ type: "text", text: "Rename the survey module." }],
						},
					],
				}),
			}),
		);
		expect(response.status).toBe(200);
		const wirePromise = responseText(response);

		/* The waiter announces itself with the busy conversation event; once
		 * that lands the poll loop is live, and the "awaited build completed"
		 * flip lands between polls. */
		await pollFor(async () => {
			const rows = await appDb
				.selectFrom("events")
				.select("event")
				.where("app_id", "=", ADOPT_APP)
				.execute();
			return rows.some((r) => JSON.stringify(r.event).includes("Waiting"))
				? true
				: undefined;
		});
		await appDb
			.updateTable("apps")
			.set({
				status: "complete",
				awaiting_input: false,
				res_settled: true,
			})
			.where("id", "=", ADOPT_APP)
			.execute();

		const wire = await wirePromise;
		expect(wire).not.toContain('"fatal":true');

		/* The stale BUILD claim rejected and the retry adopted the row's mode:
		 * the winning claim is an EDIT at the edit rate. */
		const lastClaim = claimAndReserveRunMock.mock.calls.at(-1);
		expect(lastClaim?.[1]).toBe("edit");
		expect(lastClaim?.[4]).toBe(CREDITS_PER_EDIT);

		/* The adopted run finalized as an edit: the SA's guarded commit landed
		 * (the rename persisted — the write a stale build-mode context dies
		 * on), the lock released, its own marker settled, the app untouched at
		 * `complete`. A stranded lock here is the exact pre-fix failure. */
		const row = await appDb
			.selectFrom("apps")
			.select([
				"status",
				"error_type",
				"app_name",
				"lock_run_id",
				"lock_actor_user_id",
				"res_settled",
				"res_user_id",
			])
			.where("id", "=", ADOPT_APP)
			.executeTakeFirstOrThrow();
		expect(row).toEqual({
			status: "complete",
			error_type: null,
			app_name: "Adopted edit rename",
			lock_run_id: null,
			lock_actor_user_id: null,
			res_settled: true,
			res_user_id: USER,
		});
		expect(failAppMock).not.toHaveBeenCalled();
		expect(runBuildOrchestrationMock).not.toHaveBeenCalled();
	}, 30_000);

	it("queues a turn affordable at the edit floor behind a live build instead of rejecting it at the derived build rate", async () => {
		/* The regression a derived-rate advisory reject would reintroduce:
		 * this POST derives BUILD (the app is mid-build), computes the
		 * 100-credit rate, and the balance is 50. Rejecting pre-stream at
		 * that rate turns away a turn that is actually affordable: the
		 * serialize-wait re-derives the mode at the winning poll, and once
		 * the awaited build completes this turn wins as a 5-credit EDIT. The
		 * unaffordable-build case needs no advisory read either; on a free
		 * (uncontended) app the claim transaction's own affordability check
		 * rejects pre-stream with the same 429. */
		await seedSnapshotApp({
			id: FASTFAIL_APP,
			name: "Edit-floor affordable app",
			overrides: {
				status: "generating",
				run_id: "run-other-build-live",
				run_holder_nonce: REPLACEMENT_NONCE,
				res_period: RESERVATION_PERIOD,
				res_reserved: 100,
				res_settled: false,
				res_user_id: MEMBER,
				res_run_id: "run-other-build-live",
			},
		});
		await seedBoundSession(FASTFAIL_SESSION, FASTFAIL_APP);
		await appDb
			.insertInto("credit_months")
			.values({
				user_id: USER,
				period: getCurrentPeriod(),
				allowance: 2000,
				consumed: 1950,
				bonus: 0,
				updated_at: new Date().toISOString(),
			})
			.execute();
		const model = peer.response();
		model.text("The current app is ready for your next change.");
		model.finish();

		const response = await post(
			new Request("http://localhost/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					appId: FASTFAIL_APP,
					threadId: "thread-fastfail-build-rate",
					messages: [
						{
							id: "fastfail-user",
							role: "user",
							parts: [{ type: "text", text: "Add another module." }],
						},
					],
				}),
			}),
		);

		/* Not a pre-stream 429: the stream opens and the turn queues. */
		expect(response.status).toBe(200);
		const wirePromise = responseText(response);

		await pollFor(async () => {
			const rows = await appDb
				.selectFrom("events")
				.select("event")
				.where("app_id", "=", FASTFAIL_APP)
				.execute();
			return rows.some((r) => JSON.stringify(r.event).includes("Waiting"))
				? true
				: undefined;
		});
		await appDb
			.updateTable("apps")
			.set({ status: "complete", awaiting_input: false, res_settled: true })
			.where("id", "=", FASTFAIL_APP)
			.execute();

		const wire = await wirePromise;
		expect(wire).not.toContain('"type":"out_of_credits"');
		expect(wire).not.toContain('"fatal":true');

		/* The winning claim adopted the edit rate the balance affords, and the
		 * settled charge is the 5 credits the turn actually cost. */
		const lastClaim = claimAndReserveRunMock.mock.calls.at(-1);
		expect(lastClaim?.[1]).toBe("edit");
		expect(lastClaim?.[4]).toBe(CREDITS_PER_EDIT);
		const month = await appDb
			.selectFrom("credit_months")
			.select(["consumed"])
			.where("user_id", "=", USER)
			.where("period", "=", getCurrentPeriod())
			.executeTakeFirstOrThrow();
		expect(month.consumed).toBe(1950 + CREDITS_PER_EDIT);
	}, 30_000);

	it("re-admits from a fresh snapshot when the direct-path claim rejects a stale mode", async () => {
		/* The stale-snapshot direction the direct path can hit: the unlocked
		 * admission read said `complete` (edit-shaped) but the locked row is
		 * `error` (build-shaped: a reaped build awaiting re-drive, free to
		 * claim). The flip PROVES the row changed, so the adoption must
		 * re-read the authorized snapshot — the SA seeds its working doc from
		 * it — rather than patching the mode alone and building against the
		 * stale document. */
		const { app, snapshot } = await seedSnapshotApp({
			id: DIRECT_ADOPT_APP,
			name: "Fresh build app",
			overrides: { status: "error" },
		});
		const adoptedBuildSeq = 1;
		await appDb
			.updateTable("apps")
			.set({ mutation_seq: adoptedBuildSeq })
			.where("id", "=", DIRECT_ADOPT_APP)
			.executeTakeFirstOrThrow();
		await seedBoundSession(DIRECT_ADOPT_SESSION, DIRECT_ADOPT_APP);
		resolveAuthorizedAppSnapshotMock
			.mockResolvedValueOnce({
				...snapshot,
				app: {
					...app,
					status: "complete",
					blueprint: { ...app.blueprint, appName: "Stale complete snapshot" },
				},
			})
			.mockResolvedValue(snapshot);
		/* The adopted BUILD runs the orchestrator; completing it exercises the
		 * route's real build finalize (schema converge → settle → data-done)
		 * against the claim this adoption booked. */
		runBuildOrchestrationMock.mockImplementation(async (args) => {
			args.writer.write({ type: "start", messageId: args.responseMessageId });
			const finalized = await args.finalizeCompletion({
				appId: DIRECT_ADOPT_APP,
				expectedSeq: adoptedBuildSeq,
				expectedHead: null,
			});
			args.writer.write({ type: "finish" });
			return {
				kind: "completed",
				appId: DIRECT_ADOPT_APP,
				finalSeq: adoptedBuildSeq,
				finalBlueprint: finalized.blueprint,
			};
		});

		const response = await post(
			new Request("http://localhost/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					appId: DIRECT_ADOPT_APP,
					appReady: true,
					threadId: DIRECT_ADOPT_THREAD,
					messages: [
						{
							id: "direct-adopt-user",
							role: "user",
							parts: [{ type: "text", text: "Continue the build." }],
						},
					],
				}),
			}),
		);
		expect(response.status).toBe(200);
		const wire = await responseText(response);
		expect(wire).not.toContain('"fatal":true');

		/* The stale EDIT claim rejected against the locked build-shaped row and
		 * the retry adopted BUILD at the build rate. */
		const firstClaim = claimAndReserveRunMock.mock.calls[0];
		expect(firstClaim?.[1]).toBe("edit");
		expect(firstClaim?.[4]).toBe(CREDITS_PER_EDIT);
		const lastClaim = claimAndReserveRunMock.mock.calls.at(-1);
		expect(lastClaim?.[1]).toBe("build");
		expect(lastClaim?.[4]).toBe(CREDITS_PER_BUILD);

		/* The adoption re-read the snapshot, resolved the bound session, and
		 * ran the ORCHESTRATOR (never the SA) against the materialized scope. */
		expect(
			resolveAuthorizedAppSnapshotMock.mock.calls.length,
		).toBeGreaterThanOrEqual(2);
		expect(createSolutionsArchitectMock).not.toHaveBeenCalled();
		expect(runBuildOrchestrationMock).toHaveBeenCalledTimes(1);
		expect(runBuildOrchestrationMock.mock.calls[0]?.[0]).toMatchObject({
			designSessionId: DIRECT_ADOPT_SESSION,
			proposedAppId: DIRECT_ADOPT_APP,
			materializedAppId: DIRECT_ADOPT_APP,
		});

		/* The completed-build finalize settled the claim and flipped the app
		 * back to a committed, exported-ready state. */
		const finalRow = await appDb
			.selectFrom("apps")
			.select(["status", "res_settled"])
			.where("id", "=", DIRECT_ADOPT_APP)
			.executeTakeFirstOrThrow();
		expect(finalRow).toEqual({ status: "complete", res_settled: true });
	}, 30_000);

	it("a wait-path snapshot failure settles the adopted edit before draining its event log", async () => {
		/* The accumulator was seeded with the PRE-WAIT mode (build). The poll
		 * loop adopts EDIT mid-wait, wins, and then the post-win snapshot read
		 * faults — a death BEFORE the SA-construction `configureRun` that used
		 * to be the only mode correction. The flushed summary must describe
		 * the mode the claim actually booked, or admin inspect reads a phantom
		 * zero-module build failure. */
		const { snapshot } = await seedSnapshotApp({
			id: WAITFAIL_APP,
			name: "Wait adopt summary app",
			overrides: {
				status: "generating",
				run_id: "run-other-build-summary",
				run_holder_nonce: REPLACEMENT_NONCE,
				res_period: RESERVATION_PERIOD,
				res_reserved: 100,
				res_settled: false,
				res_user_id: MEMBER,
				res_run_id: "run-other-build-summary",
			},
		});
		await seedBoundSession(WAITFAIL_SESSION, WAITFAIL_APP);
		resolveAuthorizedAppSnapshotMock
			.mockResolvedValueOnce(snapshot)
			.mockRejectedValue(new Error("post-win snapshot connection dropped"));

		let responseEnded = false;
		const releaseHolder = async () => {
			await appDb
				.updateTable("apps")
				.set({ status: "complete", awaiting_input: false, res_settled: true })
				.where("id", "=", WAITFAIL_APP)
				.execute();
		};
		const wire = await whileBlocked(
			{ uri: () => h.uri() },
			(pg) => pg.query("LOCK TABLE events IN SHARE MODE"),
			async () => {
				const response = await post(
					new Request("http://localhost/api/chat", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							appId: WAITFAIL_APP,
							threadId: WAITFAIL_THREAD,
							messages: [
								{
									id: "wait-adopt-user",
									role: "user",
									parts: [{ type: "text", text: "Rename the app." }],
								},
							],
						}),
					}),
				);
				expect(response.status).toBe(200);
				const body = await responseText(response);
				responseEnded = true;
				return body;
			},
			async (_settled, pg) => {
				// The Waiting event's real INSERT is blocked. Let the new edit claim
				// win and fail its snapshot read; the failure finalizer must own that
				// earlier event write even after its usage finalization has committed.
				await releaseHolder();
				await pollFor(async () =>
					appDb
						.selectFrom("run_summaries")
						.select("prompt_mode")
						.where("design_session_id", "=", WAITFAIL_SESSION)
						.executeTakeFirst(),
				);
				await pollFor(async () => {
					const row = await appDb
						.selectFrom("apps")
						.select("lock_run_id")
						.where("id", "=", WAITFAIL_APP)
						.executeTakeFirstOrThrow();
					return row.lock_run_id === null ? true : undefined;
				});
				await pg.query("SELECT 1");
				expect(responseEnded).toBe(false);
			},
			releaseHolder,
		);

		expect(wire).toContain('"type":"internal"');
		expect(createSolutionsArchitectMock).not.toHaveBeenCalled();

		/* The winning claim adopted edit; the flushed summary must say so. */
		const lastClaim = claimAndReserveRunMock.mock.calls.at(-1);
		expect(lastClaim?.[1]).toBe("edit");
		/* A BUILD-admitted app turn carries its design lineage, so its summary
		 * books against the session even though the claim adopted edit. */
		const summary = await appDb
			.selectFrom("run_summaries")
			.select(["prompt_mode", "app_ready"])
			.where("design_session_id", "=", WAITFAIL_SESSION)
			.executeTakeFirstOrThrow();
		expect(summary).toEqual({ prompt_mode: "edit", app_ready: true });
	}, 30_000);
});

describe("barrier persistence", () => {
	/** The thread row's marker + typed transcript, read raw. */
	async function threadRow(threadId: string) {
		const row = await threadRowMaybe(threadId);
		if (!row) throw new Error(`thread row ${threadId} not found`);
		return row;
	}

	/** Poll-safe row read: the claim's upsert races the first poll on a cold
	 *  start, and a missing row must read as "not yet", never a throw. */
	async function threadRowMaybe(threadId: string) {
		const row = await appDb
			.selectFrom("threads")
			.select([
				"messages",
				"active_stream_id",
				"active_holder_nonce",
				"clawed_back_ids",
			])
			.where("thread_id", "=", threadId)
			.executeTakeFirst();
		if (!row) return undefined;
		return {
			...row,
			messages: row.messages as {
				id: string;
				role: string;
				parts: { type: string; text?: string; state?: string }[];
			}[],
		};
	}

	it("persists each completed step at its barrier, with the step's chunks durable in the log first", async () => {
		await seedFeedEditApp();
		const model = peer.response();

		const response = await post(editTurnRequest());
		expect(response.status).toBe(200);
		const streamId = response.headers.get("x-workflow-run-id");
		if (!streamId) throw new Error("no stream id");
		const wirePromise = responseText(response);

		/* Step 1 completes; the run stays OPEN. */
		model.text("Working on module one.");
		model.tool("getLanguages", {});
		model.finish();
		const next = peer.response();

		/* The barrier lands the completed step in the thread WHILE the run is
		 * live — this mid-run row is also exactly what a process death at this
		 * instant would leave behind: the partial transcript plus the live
		 * marker the loaders would reconcile into `resume_interrupted`. */
		const mid = await pollFor(async () => {
			const row = await threadRowMaybe(THREAD);
			return row?.messages.some((m) => m.role === "assistant")
				? row
				: undefined;
		});
		expect(mid.active_stream_id).toBe(streamId);
		const midAssistant = mid.messages.find((m) => m.role === "assistant");
		expect(
			midAssistant?.parts
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join(""),
		).toBe("Working on module one.");

		/* Log-before-barrier ordering: a persisted barrier implies its
		 * `finish-step` is already durable in the chunk log, so a rewound
		 * replay can never re-deliver content the transcript already holds. */
		const midLogged = (await chunkRows(streamId)).flatMap(
			(row) => row.chunks as UIMessageChunk[],
		);
		expect(midLogged.some((c) => c.type === "finish-step")).toBe(true);

		/* Step 2 + the natural end: the terminal write merges the final state
		 * and retires the marker. */
		next.text(" Module two done.");
		next.finish();

		const final = await pollFor(async () => {
			const row = await threadRowMaybe(THREAD);
			return row?.active_stream_id === null ? row : undefined;
		});
		const assistants = final.messages.filter((m) => m.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(
			assistants[0].parts
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join(""),
		).toBe("Working on module one. Module two done.");
		await wirePromise;
	}, 30_000);

	it("claws a failed turn back keeping its partial for display, with the marker cleared and the id tombstoned", async () => {
		await seedFeedEditApp();
		const model = peer.response();

		const response = await post(editTurnRequest());
		expect(response.status).toBe(200);
		const wirePromise = responseText(response);

		/* One completed step lands at its barrier... */
		model.text("Half an answer");
		model.tool("getLanguages", {});
		model.finish();
		const next = peer.response();
		await pollFor(async () => {
			const row = await threadRowMaybe(THREAD);
			return row?.messages.some((m) => m.role === "assistant")
				? row
				: undefined;
		});

		/* ...then the generation dies with a FATAL stream error (classified
		 * non-transient, so no in-route retry). The failure funnel's terminal
		 * write clears the marker and tombstones the id, but the streamed
		 * partial STAYS in the transcript: the tab that watched it fail still
		 * shows it, and a reload must not show less than the live view did. */
		next.fail("model exploded");

		/* The stream closes only after finalize completes, and finalize runs
		 * the claw-back and the settle+release as SEQUENTIAL transactions —
		 * so the closed body is the one deterministic "every terminal write
		 * landed" signal. Polling for the claw-back alone raced the lock
		 * release on a loaded CI shard. */
		await wirePromise;

		const thread = await threadRowMaybe(THREAD);
		expect(thread?.active_stream_id).toBeNull();
		expect(thread?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		const kept = thread?.messages.at(-1) as
			| { id?: string; parts: Array<{ type: string; text?: string }> }
			| undefined;
		expect(
			kept?.parts
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join(""),
		).toBe("Half an answer");
		/* The cap-0 tombstone refuses every client copy of the kept id, so a
		 * stale tab can never grow the stored record of the failed turn. */
		expect(thread?.clawed_back_ids).toEqual([{ id: kept?.id, cap: 0 }]);
		expect(thread?.active_holder_nonce).toBeNull();

		/* A failed EDIT releases its lock and refunds without touching the
		 * committed app's status. */
		const app = await appDb
			.selectFrom("apps")
			.select(["status", "error_type", "lock_run_id"])
			.where("owner", "=", USER)
			.executeTakeFirstOrThrow();
		expect(app).toEqual({
			status: "complete",
			error_type: null,
			lock_run_id: null,
		});
	}, 30_000);

	it("a bailed POST leaves the owning run's marker and transcript alone (merge-only)", async () => {
		/* Another run owns this thread; this POST wins the serialize wait and
		 * then bails on the snapshot read. Its fold directive is `skip`
		 * (it never persisted the turn), so the owner's marker and message
		 * survive, and no empty assistant shell appears — only the bailed
		 * history merge the bail path has always done. */
		await seedSerializeWaitEdit();
		await appDb
			.insertInto("threads")
			.values({
				thread_id: WAIT_THREAD,
				app_id: WAIT_APP,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				thread_type: "edit",
				summary: "Owned by another run",
				run_id: "run-owner",
				active_stream_id: "stream-owner",
				active_holder_nonce: REPLACEMENT_NONCE,
				messages: JSON.stringify([
					{
						id: "m-owner",
						role: "user",
						parts: [{ type: "text", text: "the owner's turn" }],
					},
				]),
			})
			.execute();
		resolveAuthorizedAppSnapshotMock.mockImplementationOnce(
			async (
				...args: Parameters<
					typeof import("@/lib/db/appAccess").resolveAuthorizedAppSnapshot
				>
			) => {
				const { getAuthDb } = await import("@/lib/auth/db");
				const authDb = await getAuthDb();
				await authDb
					.deleteFrom("auth_member")
					.where("userId", "=", USER)
					.where("organizationId", "=", PROJECT)
					.execute();
				const actualAccess =
					await vi.importActual<typeof import("@/lib/db/appAccess")>(
						"@/lib/db/appAccess",
					);
				return actualAccess.resolveAuthorizedAppSnapshot(...args);
			},
		);

		const response = await post(waitingEditRequest());
		expect(response.status).toBe(200);
		await responseText(response);

		const thread = await threadRow(WAIT_THREAD);
		expect(thread.active_stream_id).toBe("stream-owner");
		expect(thread.active_holder_nonce).toBe(REPLACEMENT_NONCE);
		expect(thread.messages.map((m) => m.id)).toEqual([
			"m-owner",
			"waiting-edit-user",
		]);
		expect(thread.messages.every((m) => m.role === "user")).toBe(true);
	}, 30_000);

	it("a completed run whose marker retirement cannot land projects RETIRED, not interrupted — no phantom re-drive", async () => {
		/* Every marker-retiring write fails (fold terminal write AND all of
		 * finalize's fallback retries), so the row keeps its marker — but the
		 * app reached `complete` under this same claim, and that breadcrumb
		 * proves the run FINISHED. The loaders must project the marker retired
		 * rather than stamping `resume_interrupted`: an auto-re-drive here
		 * would trim (destroy) the finished answer and re-charge the turn. */
		await seedFeedEditApp();
		failClearMarkerWrites.on = true;
		const model = peer.response();

		const response = await post(editTurnRequest());
		expect(response.status).toBe(200);
		const streamId = response.headers.get("x-workflow-run-id");
		const wirePromise = responseText(response);

		model.text("All done.");
		model.finish();

		/* The run itself completes fully — the failure is persistence-side.
		 * The released lock is the finalize-done signal. */
		const app = await pollFor(async () => {
			const row = await appDb
				.selectFrom("apps")
				.select(["id", "status", "lock_run_id"])
				.where("owner", "=", USER)
				.executeTakeFirstOrThrow();
			return row.lock_run_id === null ? row : undefined;
		});
		expect(app.status).toBe("complete");
		await wirePromise;

		/* The barrier-persisted transcript is intact; only the marker strands
		 * on the ROW. */
		const thread = await threadRow(THREAD);
		const assistant = thread.messages.find((m) => m.role === "assistant");
		expect(
			assistant?.parts
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join(""),
		).toBe("All done.");
		expect(thread.active_stream_id).toBe(streamId);

		/* The projection retires it: no interruption stamp, no marker, and
		 * therefore no auto-re-drive against the finished answer. */
		const { loadThread } = await import("@/lib/db/threads");
		const loaded = await loadThread({ kind: "app", appId: app.id }, THREAD);
		expect(loaded?.resume_interrupted).toBeUndefined();
		expect(loaded?.active_stream_id).toBeNull();
	}, 30_000);

	it("a provider failure with failed claw-back remains interrupted even though the edited app is complete", async () => {
		/* Edit failures preserve the app's completed status. A stranded failed
		 * turn must still project interruption instead of retiring its marker. */
		await seedFeedEditApp();
		const model = peer.response();

		const response = await post(editTurnRequest());
		expect(response.status).toBe(200);
		const streamId = response.headers.get("x-workflow-run-id");
		const wirePromise = responseText(response);

		/* A completed SDK step is persisted before the next provider response
		 * fails. An injected claw-back write failure strands marker + partial. */
		failClawBackWrites.on = true;
		model.text("Half an answer");
		model.tool("getLanguages", {});
		model.finish();
		const next = peer.response();
		next.fail("provider failed after the persisted step");
		await wirePromise;

		const app = await appDb
			.selectFrom("apps")
			.select(["id", "status"])
			.where("owner", "=", USER)
			.executeTakeFirstOrThrow();
		expect(app.status).toBe("complete");

		const thread = await threadRow(THREAD);
		expect(thread.active_stream_id).toBe(streamId);
		const { loadThread } = await import("@/lib/db/threads");
		const loaded = await loadThread({ kind: "app", appId: app.id }, THREAD);
		expect(loaded?.resume_interrupted).toBe(true);
	}, 30_000);

	it("a clean-release fault preserves the finished answer while the exact-holder reaper settles its stranded charge", async () => {
		// The answer finished, but the release transaction failed. The route
		// preserves the transcript; its exact unsettled lock remains for the
		// normal reaper, whose later refund must not turn this into a re-drive.
		await seedFeedEditApp();
		clearRunLockAndSettleMock.mockImplementationOnce(async () => {
			throw new Error("settle connection dropped");
		});
		const model = peer.response();

		const response = await post(editTurnRequest());
		expect(response.status).toBe(200);
		const wirePromise = responseText(response);

		model.text("The whole answer.");
		model.finish();
		await wirePromise;

		const app = await appDb
			.selectFrom("apps")
			.select([
				"status",
				"error_type",
				"res_run_id",
				"run_holder_nonce",
				"res_settled",
				"lock_run_id",
			])
			.where("id", "=", FEED_APP)
			.executeTakeFirstOrThrow();
		expect(app.status).toBe("complete");
		expect(app.error_type).toBeNull();
		expect(app.res_settled).toBe(false);
		expect(app.lock_run_id).toBe(app.res_run_id);
		expect(refundReservationMock).not.toHaveBeenCalled();

		const thread = await pollFor(async () => {
			const row = await threadRowMaybe(THREAD);
			return row?.active_stream_id === null ? row : undefined;
		});
		const assistant = thread.messages.find((m) => m.role === "assistant");
		expect(
			assistant?.parts
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join(""),
		).toBe("The whole answer.");
		expect(thread.active_holder_nonce).toBeNull();
		if (!app.res_run_id || !app.run_holder_nonce)
			throw new Error("Stranded edit has no exact holder");
		await appDb
			.updateTable("apps")
			.set({ lock_expire_at: new Date(0) })
			.where("id", "=", FEED_APP)
			.execute();
		const { reapStaleRun } = await import("@/lib/db/apps");
		expect(
			await reapStaleRun(FEED_APP, {
				mode: "edit",
				runId: app.res_run_id,
				nonce: app.run_holder_nonce,
			}),
		).toBe("reaped");
		const reaped = await appDb
			.selectFrom("apps")
			.select(["lock_run_id", "res_settled", "status"])
			.where("id", "=", FEED_APP)
			.executeTakeFirstOrThrow();
		expect(reaped).toEqual({
			lock_run_id: null,
			res_settled: true,
			status: "complete",
		});
		const credit = await appDb
			.selectFrom("credit_months")
			.select("consumed")
			.where("user_id", "=", USER)
			.where("period", "=", getCurrentPeriod())
			.executeTakeFirstOrThrow();
		expect(credit.consumed).toBe(0);
		const { loadThread } = await import("@/lib/db/threads");
		const loaded = await loadThread({ kind: "app", appId: FEED_APP }, THREAD);
		expect(loaded?.resume_interrupted).toBeUndefined();
		expect(loaded?.messages).toEqual(thread.messages);
	}, 30_000);

	it("a failed turn whose claw-back cannot land keeps its marker so recovery can trim the partial", async () => {
		/* The failed-directive fallback must RETRY the claw-back, never fall
		 * back to a marker-only clear: retiring the marker while the partial
		 * survives would leave the failed turn's half-answer as durable
		 * history no writer may ever trim. With every claw-back failing, the
		 * marker deliberately stays — the next load reads an interruption and
		 * the re-drive claim removes the partial. */
		await seedFeedEditApp();
		failClawBackWrites.on = true;
		const model = peer.response();

		const response = await post(editTurnRequest());
		expect(response.status).toBe(200);
		const streamId = response.headers.get("x-workflow-run-id");
		const wirePromise = responseText(response);

		model.text("Half an answer");
		model.tool("getLanguages", {});
		model.finish();
		const next = peer.response();
		next.fail("model exploded");
		await wirePromise;

		const thread = await threadRow(THREAD);
		expect(thread.active_stream_id).toBe(streamId);
		expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	}, 30_000);

	it("large streamed tool inputs stay out of the log while all three mutations and the final transcript commit", async () => {
		await seedFeedEditApp();
		const model = peer.response();

		const response = await post(editTurnRequest());
		expect(response.status).toBe(200);
		const streamId = response.headers.get("x-workflow-run-id");
		if (!streamId) throw new Error("no stream id");
		const wirePromise = responseText(response);

		const names = [0, 1, 2].map((step) => `App ${step} ${"x".repeat(4_000)}`);
		for (const [step, name] of names.entries()) {
			const response = step === 0 ? model : peer.response();
			response.tool(
				"updateApp",
				{ name },
				{ callId: `call-${step}`, deltaSize: 16 },
			);
			response.finish();
		}
		const closing = peer.response();
		closing.text("Built it.");
		closing.finish();

		// EOF joins the actual producer, SDK fold and finalization; no timing
		// estimate is needed for instrumentation-heavy provider decoding.
		const wire = await wirePromise;
		expect(wire).not.toContain('"type":"tool-input-delta"');
		const thread = await threadRow(THREAD);
		expect(thread.active_stream_id).toBeNull();

		/* The log carries the run WITHOUT the deltas: a few dozen chunks, not
		 * twelve thousand input characters across more than 750 provider deltas. */
		const logged = (await chunkRows(streamId)).flatMap(
			(row) => row.chunks as UIMessageChunk[],
		);
		expect(logged.some((c) => c.type === "tool-input-delta")).toBe(false);
		expect(logged.length).toBeLessThan(80);
		const app = await appDb
			.selectFrom("apps")
			.select(["app_name", "mutation_seq"])
			.where("id", "=", FEED_APP)
			.executeTakeFirstOrThrow();
		expect(app.app_name).toBe(names[2]);
		expect(Number(app.mutation_seq)).toBe(4); // canonical birth + all three tool commits

		/* The stream's first chunk is the seed-steps statement the client's
		 * cold-resume filter windows on: a fresh turn seeds zero steps. */
		expect(logged[0]).toMatchObject({
			type: "data-seed-steps",
			data: { steps: 0 },
		});

		/* The transcript holds every completed unit: three completed tool
		 * calls and the closing text, written barrier by barrier. */
		const assistant = thread.messages.find((m) => m.role === "assistant");
		const toolParts = (assistant?.parts ?? []).filter(
			(p) => p.type === "tool-updateApp",
		);
		expect(toolParts).toHaveLength(3);
		expect(toolParts.every((p) => p.state === "output-available")).toBe(true);
		expect(
			(assistant?.parts ?? [])
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join(""),
		).toBe("Built it.");
	}, 30_000);
});
