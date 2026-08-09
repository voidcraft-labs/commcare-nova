/**
 * Design-session run lifecycle — the pre-app target's claim/reserve/pause/
 * settle/refund/reap protocol on a real per-test Postgres, plus the §20.9
 * cross-target admission concurrency matrix and the §18.4
 * impossible-combination database rejections.
 *
 * The invariants mirror the app run-lifecycle matrix deliberately: claim +
 * cross-target concurrency check + affordability + reservation + holder
 * write are ONE transaction; two concurrent new sessions for one actor can
 * never both hold; credits settle or refund exactly once; every terminal
 * writer's exact-holder compare-and-set makes a stale ghost a no-op; and a
 * question-only session leaves no app anywhere.
 */
import { describe, expect, it } from "vitest";
import { AppAccessError } from "../appAccess";
import { GenerationInProgressError, RunConflictError } from "../apps";
import { OutOfCreditsError, refundDesignSessionReservation } from "../credits";
import {
	claimAndReserveDesignSessionRun,
	completeAndSettleDesignSessionRun,
	createAndClaimDesignSessionRun,
	createEditDesignSession,
	DesignSessionBusyError,
	DesignSessionStateError,
	discardDesignSession,
	failAndRefundDesignSessionRun,
	reacquireDesignSessionLease,
	refreshDesignSessionLiveness,
	setDesignSessionActiveArtifacts,
	setDesignSessionAwaitingInput,
} from "../designSessions";
import { resolveGenerationTargetScope } from "../generationTargetScope";
import { getCurrentPeriod } from "../period";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("design_sessions_");
const ACTOR = "owner-test";
const PROJECT = "project-test";
const PERIOD = getCurrentPeriod();
const NONCE = "00000000-0000-4000-8000-0000000000d1";

describe("active design artifact selection", () => {
	it("requires the exact holder and one accepted same-session lineage", async () => {
		const runId = "run-active-artifacts";
		const sessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			project_id: PROJECT,
			run_id: runId,
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() + 60_000),
		});
		const lineage = await h.seedDesignLineage({ existingSessionId: sessionId });
		await setDesignSessionActiveArtifacts({
			designSessionId: sessionId,
			actorUserId: ACTOR,
			runId,
			holderNonce: NONCE,
			expectedProjectId: PROJECT,
			activeDesignRevisionId: lineage.designRevisionId,
			activeBuildPlanId: lineage.buildPlanId,
		});
		expect(await h.readDesignSessionRow(sessionId)).toMatchObject({
			active_design_revision_id: lineage.designRevisionId,
			active_build_plan_id: lineage.buildPlanId,
		});

		const foreignSessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			project_id: PROJECT,
		});
		const foreign = await h.seedDesignLineage({
			existingSessionId: foreignSessionId,
		});
		await expect(
			setDesignSessionActiveArtifacts({
				designSessionId: sessionId,
				actorUserId: ACTOR,
				runId,
				holderNonce: NONCE,
				expectedProjectId: PROJECT,
				activeDesignRevisionId: foreign.designRevisionId,
				activeBuildPlanId: foreign.buildPlanId,
			}),
		).rejects.toBeInstanceOf(DesignSessionStateError);

		await h
			.db()
			.updateTable("design_sessions")
			.set({ run_holder_nonce: crypto.randomUUID() })
			.where("id", "=", sessionId)
			.execute();
		await expect(
			setDesignSessionActiveArtifacts({
				designSessionId: sessionId,
				actorUserId: ACTOR,
				runId,
				holderNonce: NONCE,
				expectedProjectId: PROJECT,
				activeDesignRevisionId: lineage.designRevisionId,
				activeBuildPlanId: lineage.buildPlanId,
			}),
		).rejects.toMatchObject({ name: "RunHolderLostError" });
	});
});

async function seedActor(balance = 2000): Promise<void> {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	await h.seedCreditMonth(ACTOR, PERIOD, {
		allowance: balance,
		consumed: 0,
		bonus: 0,
	});
}

describe("createAndClaimDesignSessionRun", () => {
	it("creates, claims, and reserves in one transaction — holder and marker land together", async () => {
		await seedActor();
		const created = await createAndClaimDesignSessionRun({
			projectId: PROJECT,
			actorUserId: ACTOR,
			runId: "run-1",
			cost: 100,
		});
		const row = await h.readDesignSessionRow(created.designSessionId);
		expect(row).toMatchObject({
			mode: "build",
			state: "active",
			project_id: PROJECT,
			owner_user_id: ACTOR,
			app_id: null,
			run_id: "run-1",
			run_actor_user_id: ACTOR,
			run_mode: "build",
			res_period: PERIOD,
			res_reserved: 100,
			res_settled: false,
			res_user_id: ACTOR,
			res_run_id: "run-1",
		});
		expect(row?.proposed_app_id).toBeTruthy();
		expect(created.reservation).toEqual({ period: PERIOD, reserved: 100 });
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(100);
		/* A question-only session leaves no app anywhere. */
		const apps = await h.db().selectFrom("apps").select("id").execute();
		expect(apps).toEqual([]);
	});

	it("rejects on the cross-target cap when the actor already holds a live APP build — a rollback that created nothing", async () => {
		await seedActor();
		await h.seedApp({
			id: "app-live",
			owner: ACTOR,
			status: "generating",
			run_id: "run-app",
			run_holder_nonce: NONCE,
		});
		await expect(
			createAndClaimDesignSessionRun({
				projectId: PROJECT,
				actorUserId: ACTOR,
				runId: "run-2",
				cost: 100,
			}),
		).rejects.toBeInstanceOf(GenerationInProgressError);
		const sessions = await h
			.db()
			.selectFrom("design_sessions")
			.select("id")
			.execute();
		expect(sessions).toEqual([]);
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(0);
	});

	it("rejects out-of-credits atomically — no session row, no debit (§20.9 rollback)", async () => {
		await seedActor(40);
		await expect(
			createAndClaimDesignSessionRun({
				projectId: PROJECT,
				actorUserId: ACTOR,
				runId: "run-3",
				cost: 100,
			}),
		).rejects.toBeInstanceOf(OutOfCreditsError);
		expect(
			await h.db().selectFrom("design_sessions").select("id").execute(),
		).toEqual([]);
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(0);
	});

	it("two concurrent new design sessions for one actor cannot both hold (§20.9)", async () => {
		await seedActor();
		/* Two racing create+claim transactions on two pooled connections. The
		 * per-actor advisory gate serializes them; the loser's in-transaction
		 * scan then sees the winner's live holder and rejects with the
		 * cross-target cap — never two sessions, never two reservations. */
		const outcomes = await Promise.allSettled([
			createAndClaimDesignSessionRun({
				projectId: PROJECT,
				actorUserId: ACTOR,
				runId: "run-a",
				cost: 100,
			}),
			createAndClaimDesignSessionRun({
				projectId: PROJECT,
				actorUserId: ACTOR,
				runId: "run-b",
				cost: 100,
			}),
		]);
		const wins = outcomes.filter((o) => o.status === "fulfilled");
		const losses = outcomes.filter(
			(o) =>
				o.status === "rejected" &&
				o.reason instanceof GenerationInProgressError,
		);
		expect(wins).toHaveLength(1);
		expect(losses).toHaveLength(1);
		const sessions = await h
			.db()
			.selectFrom("design_sessions")
			.select(["id", "run_id"])
			.execute();
		expect(sessions).toHaveLength(1);
		/* Exactly one reservation was booked. */
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(100);
	});
});

describe("claimAndReserveDesignSessionRun", () => {
	async function seedIdleSession(): Promise<string> {
		await seedActor();
		return h.seedDesignSession({
			owner_user_id: ACTOR,
			last_error_type: "internal",
		});
	}

	it("re-claims an idle session: fresh holder, fresh marker, error cleared", async () => {
		const sessionId = await seedIdleSession();
		const claimed = await claimAndReserveDesignSessionRun(
			sessionId,
			"run-re",
			ACTOR,
			100,
			PROJECT,
			NONCE,
		);
		expect(claimed.holderNonce).toBe(NONCE);
		const row = await h.readDesignSessionRow(sessionId);
		expect(row).toMatchObject({
			run_id: "run-re",
			run_holder_nonce: NONCE,
			res_run_id: "run-re",
			res_settled: false,
			last_error_type: null,
			awaiting_input: false,
		});
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(100);
	});

	it("supersedes the claimant's OWN paused round, refunding its hold in the same debit", async () => {
		await seedActor();
		const sessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			awaiting_input: true,
			run_id: "run-old",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: "run-old",
			},
		});
		await h.seedCreditMonth(ACTOR, PERIOD, {
			allowance: 2000,
			consumed: 100,
			bonus: 0,
		});
		await claimAndReserveDesignSessionRun(
			sessionId,
			"run-new",
			ACTOR,
			100,
			PROJECT,
		);
		/* The old hold refunded, the new one booked: net consumed stays 100. */
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(100);
		expect(await h.readDesignSessionReservation(sessionId)).toMatchObject({
			runId: "run-new",
			settled: false,
		});
	});

	it("conflicts on another actor's paused round and on any live holder", async () => {
		await seedActor();
		await h.seedProjectMember("other-actor", PROJECT, "editor");
		const sessionId = await h.seedDesignSession({
			owner_user_id: "other-actor",
			awaiting_input: true,
			run_id: "run-theirs",
			run_holder_nonce: NONCE,
			run_actor_user_id: "other-actor",
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: "other-actor",
				runId: "run-theirs",
			},
		});
		/* The conflict speaks the DESIGN vocabulary — a pre-app session has
		 * no app to name (the person-to-person error rule). */
		const conflict = await claimAndReserveDesignSessionRun(
			sessionId,
			"run-x",
			ACTOR,
			100,
			PROJECT,
		).catch((error: unknown) => error);
		expect(conflict).toBeInstanceOf(RunConflictError);
		expect((conflict as Error).message).toContain("this design");
	});

	it("claim racing the reaper on a lapsed session: exactly one holder or none survives (§20.9)", async () => {
		await seedActor();
		const sessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			run_id: "run-stale",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() - 60_000),
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: "run-stale",
			},
		});
		await h.seedCreditMonth(ACTOR, PERIOD, {
			allowance: 2000,
			consumed: 100,
			bonus: 0,
		});
		const { refundStaleDesignSessionRun } = await import("../credits");
		const [claim, reap] = await Promise.allSettled([
			claimAndReserveDesignSessionRun(
				sessionId,
				"run-take",
				ACTOR,
				100,
				PROJECT,
			),
			refundStaleDesignSessionRun(sessionId, {
				mode: "build",
				runId: "run-stale",
				nonce: NONCE,
			}),
		]);
		expect(claim.status).toBe("fulfilled");
		expect(reap.status).toBe("fulfilled");
		const row = await h.readDesignSessionRow(sessionId);
		/* Whichever order the gate serialized them in, the surviving state is
		 * the fresh claim's holder with exactly one live hold and no
		 * double-refund: the stale hold was returned exactly once (by the
		 * reaper or by the claim's leftover-refund arm). */
		expect(row).toMatchObject({
			run_id: "run-take",
			res_run_id: "run-take",
			res_settled: false,
		});
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(100);
	});

	it("rejects an edit-mode session and terminal states with typed errors", async () => {
		await seedActor();
		const appId = await h.seedApp({ id: "app-bound" });
		const editSession = await h.seedDesignSession({
			mode: "edit",
			app_id: appId,
			proposed_app_id: null,
			owner_user_id: ACTOR,
		});
		await expect(
			claimAndReserveDesignSessionRun(editSession, "r", ACTOR, 5, PROJECT),
		).rejects.toMatchObject({ reason: "edit_mode_holds_no_run" });
		const abandoned = await h.seedDesignSession({
			owner_user_id: ACTOR,
			state: "abandoned",
		});
		await expect(
			claimAndReserveDesignSessionRun(abandoned, "r", ACTOR, 100, PROJECT),
		).rejects.toMatchObject({ reason: "not_active" });
	});
});

describe("pause / resume / heartbeat", () => {
	async function seedHeldSession(): Promise<string> {
		await seedActor();
		return h.seedDesignSession({
			owner_user_id: ACTOR,
			run_id: "run-held",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: "run-held",
			},
		});
	}

	it("pause stamps awaiting_input without extending the lease; clear re-arms it (§20.10)", async () => {
		const sessionId = await seedHeldSession();
		const before = await h.readDesignSessionRow(sessionId);
		expect(
			await setDesignSessionAwaitingInput(
				sessionId,
				"run-held",
				NONCE,
				true,
				ACTOR,
				PROJECT,
			),
		).toBe("owned");
		const paused = await h.readDesignSessionRow(sessionId);
		expect(paused?.awaiting_input).toBe(true);
		expect(paused?.run_lease_expires_at).toEqual(before?.run_lease_expires_at);
		expect(
			await setDesignSessionAwaitingInput(
				sessionId,
				"run-held",
				NONCE,
				false,
				ACTOR,
				PROJECT,
			),
		).toBe("owned");
		const resumed = await h.readDesignSessionRow(sessionId);
		expect(resumed?.awaiting_input).toBe(false);
		expect(
			(resumed?.run_lease_expires_at as Date | undefined)?.getTime() ?? 0,
		).toBeGreaterThan(
			(before?.run_lease_expires_at as Date | undefined)?.getTime() ?? 0,
		);
	});

	it("a stale nonce cannot pause a successor (superseded), a released run reads released", async () => {
		const sessionId = await seedHeldSession();
		expect(
			await setDesignSessionAwaitingInput(
				sessionId,
				"run-held",
				"00000000-0000-4000-8000-0000000000ff",
				true,
				ACTOR,
				PROJECT,
			),
		).toBe("superseded");
		await failAndRefundDesignSessionRun(
			sessionId,
			"run-held",
			NONCE,
			"internal",
		);
		expect(
			await setDesignSessionAwaitingInput(
				sessionId,
				"run-held",
				NONCE,
				true,
				ACTOR,
				PROJECT,
			),
		).toBe("released");
	});

	it("resume requires the exact actor/run/nonce; a missing nonce is refresh_required (§20.10)", async () => {
		const sessionId = await seedHeldSession();
		await setDesignSessionAwaitingInput(
			sessionId,
			"run-held",
			NONCE,
			true,
			ACTOR,
			PROJECT,
		);
		expect(
			await reacquireDesignSessionLease(
				sessionId,
				"run-held",
				null,
				ACTOR,
				PROJECT,
			),
		).toEqual({ outcome: "refresh_required" });
		expect(
			await reacquireDesignSessionLease(
				sessionId,
				"run-other",
				NONCE,
				ACTOR,
				PROJECT,
			),
		).toEqual({ outcome: "superseded" });
		const owned = await reacquireDesignSessionLease(
			sessionId,
			"run-held",
			NONCE,
			ACTOR,
			PROJECT,
		);
		expect(owned).toEqual({ outcome: "owned", holderNonce: NONCE });
		const row = await h.readDesignSessionRow(sessionId);
		expect(row?.awaiting_input).toBe(false);
	});

	it("the heartbeat extends only the exact live holder's lease", async () => {
		const sessionId = await seedHeldSession();
		const before = await h.readDesignSessionRow(sessionId);
		await refreshDesignSessionLiveness(sessionId, "run-held", NONCE);
		const after = await h.readDesignSessionRow(sessionId);
		expect(
			(after?.run_lease_expires_at as Date | undefined)?.getTime() ?? 0,
		).toBeGreaterThan(
			(before?.run_lease_expires_at as Date | undefined)?.getTime() ?? 0,
		);
		await refreshDesignSessionLiveness(
			sessionId,
			"run-held",
			"00000000-0000-4000-8000-0000000000ff",
		);
		const unchanged = await h.readDesignSessionRow(sessionId);
		expect(unchanged?.run_lease_expires_at).toEqual(
			after?.run_lease_expires_at,
		);
	});
});

describe("terminal writers (§20.10)", () => {
	async function seedHeldSession(runId = "run-t"): Promise<string> {
		await seedActor();
		await h.seedCreditMonth(ACTOR, PERIOD, {
			allowance: 2000,
			consumed: 100,
			bonus: 0,
		});
		return h.seedDesignSession({
			owner_user_id: ACTOR,
			run_id: runId,
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId,
			},
		});
	}

	it("clean completion keeps the charge and releases the complete authority state", async () => {
		const sessionId = await seedHeldSession();
		expect(
			await completeAndSettleDesignSessionRun(sessionId, "run-t", NONCE),
		).toBe("owned");
		const row = await h.readDesignSessionRow(sessionId);
		expect(row).toMatchObject({
			state: "active",
			run_id: null,
			run_holder_nonce: null,
			res_period: null,
			last_error_type: null,
			awaiting_input: false,
		});
		/* Kept charge: consumed stays debited. */
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(100);
		/* A later flush refund finds no owned marker and no-ops — settled
		 * exactly once, refunded never. */
		await refundDesignSessionReservation(sessionId, "run-t", NONCE);
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(100);
	});

	it("failure refunds exactly once, records the error, and releases", async () => {
		const sessionId = await seedHeldSession();
		const outcome = await failAndRefundDesignSessionRun(
			sessionId,
			"run-t",
			NONCE,
			"provider_error",
		);
		expect(outcome).toEqual({ settled: true, outcome: "owned" });
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(0);
		const row = await h.readDesignSessionRow(sessionId);
		expect(row).toMatchObject({
			state: "active",
			run_id: null,
			res_period: null,
			last_error_type: "provider_error",
		});
		/* Idempotent: a ghost's second failure write is a no-op. */
		expect(
			await failAndRefundDesignSessionRun(
				sessionId,
				"run-t",
				NONCE,
				"internal",
			),
		).toEqual({ settled: false, outcome: "released" });
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(0);
	});

	it("the flush refund settles in place and the terminal release then clears (refund exactly once)", async () => {
		const sessionId = await seedHeldSession();
		await refundDesignSessionReservation(sessionId, "run-t", NONCE);
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(0);
		expect(await h.readDesignSessionReservation(sessionId)).toMatchObject({
			settled: true,
			runId: "run-t",
		});
		/* The failed-run terminal writer then releases without a second
		 * refund. */
		await failAndRefundDesignSessionRun(sessionId, "run-t", NONCE, "internal");
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(0);
		expect(await h.readDesignSessionReservation(sessionId)).toBeUndefined();
	});

	it("the reaper refunds a lapsed run once, stamps the abandoned-pause classification, and a stale ghost cannot reap a successor", async () => {
		await seedActor();
		await h.seedCreditMonth(ACTOR, PERIOD, {
			allowance: 2000,
			consumed: 100,
			bonus: 0,
		});
		const sessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			awaiting_input: true,
			run_id: "run-stale",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() - 60_000),
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: "run-stale",
			},
		});
		const { refundStaleDesignSessionRun } = await import("../credits");
		expect(
			await refundStaleDesignSessionRun(sessionId, {
				mode: "build",
				runId: "run-stale",
				nonce: NONCE,
			}),
		).toBe("reaped");
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(0);
		expect(await h.readDesignSessionRow(sessionId)).toMatchObject({
			state: "active",
			run_id: null,
			last_error_type: "paused_timeout",
		});
		/* The reaped identity cannot reap again (state_changed), and a fresh
		 * claim's holder is out of its reach entirely. */
		expect(
			await refundStaleDesignSessionRun(sessionId, {
				mode: "build",
				runId: "run-stale",
				nonce: NONCE,
			}),
		).toBe("state_changed");
	});
});

describe("discard (§11.12) and edit sessions", () => {
	it("discard refunds the remaining hold, abandons, and is owner-only + busy-guarded", async () => {
		await seedActor();
		await h.seedProjectMember("co-member", PROJECT, "editor");
		await h.seedCreditMonth(ACTOR, PERIOD, {
			allowance: 2000,
			consumed: 100,
			bonus: 0,
		});
		const sessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			run_id: "run-d",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: "run-d",
			},
		});
		/* Busy while its run is live. */
		await expect(
			discardDesignSession(sessionId, ACTOR, PROJECT),
		).rejects.toBeInstanceOf(DesignSessionBusyError);
		/* A paused own round discards (supersede semantics). */
		await setDesignSessionAwaitingInput(
			sessionId,
			"run-d",
			NONCE,
			true,
			ACTOR,
			PROJECT,
		);
		await expect(
			discardDesignSession(sessionId, "co-member", PROJECT),
		).rejects.toBeInstanceOf(DesignSessionStateError);
		expect(await discardDesignSession(sessionId, ACTOR, PROJECT)).toEqual({
			outcome: "discarded",
		});
		expect(await h.readConsumed(ACTOR, PERIOD)).toBe(0);
		expect(await h.readDesignSessionRow(sessionId)).toMatchObject({
			state: "abandoned",
			run_id: null,
			res_period: null,
		});
		/* Idempotent. */
		expect(await discardDesignSession(sessionId, ACTOR, PROJECT)).toEqual({
			outcome: "already_abandoned",
		});
		/* No app was ever created. */
		const apps = await h.db().selectFrom("apps").select("id").execute();
		expect(apps).toEqual([]);
	});

	it("an edit session cannot be born tenancy-diverged from its app", async () => {
		/* The session's Project must agree with its bound app's BY
		 * CONSTRUCTION: the Project move only re-tenants rows that exist, so
		 * an insert from a stale pre-move snapshot would diverge forever.
		 * The insert holds the app row FOR SHARE and rejects a caller whose
		 * snapshot no longer matches. */
		await seedActor();
		const appId = await h.seedApp({ id: "app-edit-tenancy" });
		await expect(
			createEditDesignSession({
				appId,
				projectId: "project-moved-away",
				actorUserId: ACTOR,
			}),
		).rejects.toMatchObject({ name: "AppProjectChangedError" });
		expect(
			await h
				.db()
				.selectFrom("design_sessions")
				.select("id")
				.where("app_id", "=", appId)
				.executeTakeFirst(),
		).toBeUndefined();
	});

	it("an edit design session carries no authority and the database rejects one that tries (§18.4)", async () => {
		await seedActor();
		const appId = await h.seedApp({ id: "app-edit-scope" });
		const { designSessionId } = await createEditDesignSession({
			appId,
			projectId: PROJECT,
			actorUserId: ACTOR,
		});
		expect(await h.readDesignSessionRow(designSessionId)).toMatchObject({
			mode: "edit",
			app_id: appId,
			run_id: null,
			res_period: null,
		});
		await expect(
			h
				.db()
				.updateTable("design_sessions")
				.set({
					run_id: "run-forged",
					run_holder_nonce: NONCE,
					run_actor_user_id: ACTOR,
					run_mode: "build",
				})
				.where("id", "=", designSessionId)
				.execute(),
		).rejects.toThrow(
			/design_sessions_edit_carries_no_authority|run_only_on_build/,
		);
	});
});

describe("§18.4 impossible combinations are database-rejected", () => {
	const insert = (values: Record<string, unknown>) =>
		h
			.db()
			.insertInto("design_sessions")
			.values({
				id: crypto.randomUUID(),
				mode: "build",
				project_id: PROJECT,
				owner_user_id: ACTOR,
				proposed_app_id: crypto.randomUUID(),
				app_id: null,
				state: "active",
				awaiting_input: false,
				...values,
			} as never)
			.execute();

	it("build without proposed_app_id / edit without app_id", async () => {
		await expect(insert({ proposed_app_id: null })).rejects.toThrow(
			/design_sessions_mode_target/,
		);
		await expect(
			insert({ mode: "edit", proposed_app_id: null, app_id: null }),
		).rejects.toThrow(/design_sessions_mode_target/);
	});

	it("an active build session cannot carry an app id", async () => {
		const appId = await h.seedApp({ id: "app-x" });
		await expect(insert({ app_id: appId })).rejects.toThrow(
			/design_sessions_active_build_has_no_app/,
		);
	});

	it("a partial holder group and a partial reservation group are unrepresentable", async () => {
		await expect(insert({ run_id: "run-partial" })).rejects.toThrow(
			/design_sessions_holder_group_complete|design_sessions_run_only_on_build/,
		);
		await expect(insert({ res_period: PERIOD })).rejects.toThrow(
			/design_sessions_reservation_group_complete/,
		);
	});

	it("a terminal state cannot retain authority columns; materialized/completed pair with the right mode", async () => {
		await expect(
			insert({
				state: "abandoned",
				run_id: "run-z",
				run_holder_nonce: NONCE,
				run_actor_user_id: ACTOR,
				run_mode: "build",
			}),
		).rejects.toThrow(/design_sessions_terminal_clears_authority/);
		await expect(insert({ state: "materialized" })).rejects.toThrow(
			/design_sessions_materialized_is_build_with_app/,
		);
		await expect(insert({ state: "completed" })).rejects.toThrow(
			/design_sessions_completed_is_edit_with_app/,
		);
	});

	it("a reservation must name its run and actor exactly", async () => {
		await expect(
			insert({
				run_id: "run-1",
				run_holder_nonce: NONCE,
				run_actor_user_id: ACTOR,
				run_mode: "build",
				res_period: PERIOD,
				res_reserved: 100,
				res_settled: false,
				res_user_id: ACTOR,
				res_run_id: "run-2",
			}),
		).rejects.toThrow(/design_sessions_reservation_names_run/);
	});
});

describe("target resolver (§ opaque authorization)", () => {
	it("resolves an authorized session and collapses foreign/missing ids to opaque not-found", async () => {
		await seedActor();
		const sessionId = await h.seedDesignSession({ owner_user_id: ACTOR });
		const resolved = await resolveGenerationTargetScope(
			{ kind: "design-session", designSessionId: sessionId },
			ACTOR,
			"edit",
		);
		expect(resolved).toMatchObject({
			projectId: PROJECT,
			appId: null,
			state: "active",
		});
		/* A non-member reads exactly what a missing id reads. */
		await expect(
			resolveGenerationTargetScope(
				{ kind: "design-session", designSessionId: sessionId },
				"stranger",
				"view",
			),
		).rejects.toBeInstanceOf(AppAccessError);
		await expect(
			resolveGenerationTargetScope(
				{
					kind: "design-session",
					designSessionId: "00000000-0000-4000-8000-00000000dead",
				},
				ACTOR,
				"view",
			),
		).rejects.toBeInstanceOf(AppAccessError);
	});
});
