/**
 * Design-session lifecycle — the pre-app generation target's run protocol,
 * on Postgres row locks (`design_sessions`, migration 20260809000000).
 *
 * A BUILD design session is the durable scope a chat build converses, bills,
 * pauses, streams, and recovers against BEFORE any app row exists: it
 * carries the same holder + reservation column groups the `apps` row
 * carries, claimed/settled/reaped through the same `(mode, runId, nonce)`
 * exact-holder discipline — every writer here is a target-polymorphic twin
 * of an `apps.ts` lifecycle writer, deliberately kept protocol-identical.
 * An EDIT design session is an artifact/orchestration scope only: its bound
 * app row remains the sole run/credit/mutation authority, and the table's
 * CHECKs make holder/reservation/pause columns on it unrepresentable.
 *
 * LOCK ORDER (the §11.13 lifecycle amendment): every transaction here that
 * creates, claims, reacquires, pauses, settles, refunds, reaps, or discards
 * a holder/reservation takes the per-actor generation admission gate FIRST
 * (`lib/db/actorGenerationGate.ts`), then the session row, then the
 * membership gate/member row, then credit rows. Claim, cross-target
 * concurrency check, affordability, reservation, and holder write are ONE
 * transaction; two concurrent new sessions for one actor can never both
 * hold. The liveness heartbeat is the one unchanged-holder write and stays
 * row-first with no gate, like the app heartbeats.
 *
 * Sessions are STRICTER than apps by construction: the holder and
 * reservation groups travel whole and a marker never outlives its holder,
 * so every terminal writer settles/refunds and clears BOTH groups in one
 * transaction, and there is no reaper-signature/false-reap self-heal arm.
 * A failed or reaped session stays `active` with `last_error_type` set —
 * recoverable (a new chargeable claim re-drives it) or discardable;
 * `discardDesignSession` moves it to `abandoned`, while materialization
 * transfers its authority once and moves it to `materialized`.
 *
 * The chat route and build recovery UI consume this surface; the integration
 * suites pin its holder, billing, authorization, and recovery invariants.
 */

import type { Transaction } from "kysely";
import { log } from "@/lib/logger";
import {
	lockActorGenerationGate,
	lockActorGenerationGateForSessionHolder,
	type ReapableGenerationTarget,
	scanActorGenerationTargets,
} from "./actorGenerationGate";
import {
	GenerationInProgressError,
	RunConflictError,
	reapStaleGenerating,
} from "./apps";
import { assertProjectCapabilityInTransaction } from "./canonicalCommitKernel";
import { AppProjectChangedError, RunHolderLostError } from "./commitGuard";
import {
	debitForDesignSessionReservation,
	type Reservation,
	refundStaleDesignSessionRun,
	refundToMonthInTransaction,
	settleAndReleaseDesignSessionRun,
} from "./credits";
import {
	designSessionReservation,
	LEASE_COLUMNS,
	leaseView,
} from "./leaseView";
import { getCurrentPeriod } from "./period";
import { type AppDatabase, getAppDb, withAppTx } from "./pg";
import {
	designSessionAuthorityCleared,
	type ExactRunHolderIdentity,
	exactRunHolderMatches,
	expectedDesignSessionHolderPredicate,
	expectedPausedDesignSessionResumePredicate,
	toExactRunHolderIdentity,
	updatedExactlyOne,
} from "./runHolderWrites";
import {
	type DesignSessionLeaseRow,
	designSessionLeaseDeadlineMs,
	designSessionLeaseState,
	runLeaseState,
} from "./runLiveness";

// ── Types ──────────────────────────────────────────────────────────

export const DESIGN_SESSION_MODES = ["build", "edit"] as const;
export type DesignSessionMode = (typeof DESIGN_SESSION_MODES)[number];

export const DESIGN_SESSION_STATES = [
	"active",
	"materialized",
	"completed",
	"abandoned",
] as const;
export type DesignSessionState = (typeof DESIGN_SESSION_STATES)[number];

/** Strict database-text admission for the closed vocabularies. */
export function parsePersistedDesignSessionMode(
	value: string,
): DesignSessionMode {
	if (value === "build" || value === "edit") return value;
	throw new Error("Persisted design-session mode is invalid.");
}

export function parsePersistedDesignSessionState(
	value: string,
): DesignSessionState {
	if (
		value === "active" ||
		value === "materialized" ||
		value === "completed" ||
		value === "abandoned"
	) {
		return value;
	}
	throw new Error("Persisted design-session state is invalid.");
}

/** The assembled design-session record. */
export interface DesignSessionDoc {
	id: string;
	mode: DesignSessionMode;
	project_id: string;
	owner_user_id: string;
	proposed_app_id: string | null;
	app_id: string | null;
	state: DesignSessionState;
	awaiting_input: boolean;
	run_id: string | null;
	run_holder_nonce: string | null;
	run_actor_user_id: string | null;
	run_lease_expires_at: Date | null;
	last_error_type: string | null;
	active_design_revision_id: string | null;
	active_build_plan_id: string | null;
	created_at: Date;
	updated_at: Date;
}

/** Thrown when a claim/discard names a session whose mode or state cannot
 * carry it — an edit session asked to hold a run, a terminal session asked
 * to claim. The message names the refused shape for the caller's log. */
export class DesignSessionStateError extends Error {
	readonly name = "DesignSessionStateError";
	constructor(
		readonly reason:
			| "not_found"
			| "edit_mode_holds_no_run"
			| "not_active"
			| "not_build",
		message: string,
	) {
		super(message);
	}
}

export type { Reservation };

/** What a successful design-session claim returns. */
export interface ClaimedDesignSessionRun {
	reservation: Reservation;
	holderNonce: string;
}

/** The receipt a fresh build session's create+claim returns. */
export interface CreatedDesignSessionRun extends ClaimedDesignSessionRun {
	designSessionId: string;
	proposedAppId: string;
}

// ── Internal helpers ───────────────────────────────────────────────

const SESSION_LEASE_SELECT = [
	"id",
	"mode",
	"project_id",
	"owner_user_id",
	"proposed_app_id",
	"app_id",
	"state",
	"awaiting_input",
	"run_id",
	"run_holder_nonce",
	"run_actor_user_id",
	"run_mode",
	"run_lease_expires_at",
	"res_period",
	"res_reserved",
	"res_settled",
	"res_user_id",
	"res_run_id",
	"last_error_type",
	"created_at",
	"updated_at",
] as const;

export type LockedSessionRow = DesignSessionLeaseRow & {
	id: string;
	mode: string;
	project_id: string;
	proposed_app_id: string | null;
	app_id: string | null;
	last_error_type: string | null;
	created_at: Date;
};

/**
 * Lock one design-session row `FOR UPDATE` — the authority-carrier lock every
 * session-first transaction takes (the lifecycle writers here, a genesis
 * change set's stage/commit transactions, and the materialization transfer).
 * Callers own the §11.13 ordering around it: lifecycle writers take the actor
 * gate first; unchanged-holder staging takes no gate and leads with this row.
 */
export async function lockSessionRow(
	tx: Transaction<AppDatabase>,
	designSessionId: string,
): Promise<LockedSessionRow | undefined> {
	return (await tx
		.selectFrom("design_sessions")
		.select([...SESSION_LEASE_SELECT])
		.where("id", "=", designSessionId)
		.forUpdate()
		.executeTakeFirst()) as LockedSessionRow | undefined;
}

/**
 * Lock and prove the exact live authority carrier for a build design session.
 * Before materialization the session row carries the holder; afterwards its
 * write-once app mapping delegates authority to the app row. Membership and
 * Project scope are reauthorized under the same transaction and lock.
 */
export async function assertDesignSessionRunAuthorityInTransaction(
	tx: Transaction<AppDatabase>,
	args: {
		readonly designSessionId: string;
		readonly actorUserId: string;
		readonly expectedProjectId: string;
		readonly holder: ExactRunHolderIdentity;
	},
): Promise<{ appId: string | null }> {
	const mapping = await tx
		.selectFrom("design_sessions")
		.select(["app_id"])
		.where("id", "=", args.designSessionId)
		.executeTakeFirst();
	if (mapping === undefined) throw new RunHolderLostError("released");
	if (mapping.app_id !== null) {
		const app = await tx
			.selectFrom("apps")
			.select([...LEASE_COLUMNS, "project_id"])
			.where("id", "=", mapping.app_id)
			.forUpdate()
			.executeTakeFirst();
		if (app === undefined || app.project_id !== args.expectedProjectId) {
			throw new RunHolderLostError("released");
		}
		await assertProjectCapabilityInTransaction(
			tx,
			args.actorUserId,
			app.project_id,
			"edit",
			"You no longer have edit access to this design's Project.",
		);
		const lease = runLeaseState(leaseView(app));
		const holderActor =
			args.holder.mode === "edit"
				? app.lock_actor_user_id
				: (app.res_user_id ?? app.owner);
		if (
			!lease.live ||
			holderActor !== args.actorUserId ||
			!exactRunHolderMatches(lease.holderIdentity, args.holder)
		) {
			throw new RunHolderLostError();
		}
		return { appId: mapping.app_id };
	}
	const session = await lockSessionRow(tx, args.designSessionId);
	if (
		session === undefined ||
		session.app_id !== null ||
		session.project_id !== args.expectedProjectId ||
		session.owner_user_id !== args.actorUserId ||
		session.run_actor_user_id !== args.actorUserId
	) {
		throw new RunHolderLostError("released");
	}
	await assertProjectCapabilityInTransaction(
		tx,
		args.actorUserId,
		session.project_id,
		"edit",
		"You no longer have edit access to this design's Project.",
	);
	const lease = designSessionLeaseState(session);
	if (
		!lease.live ||
		!exactRunHolderMatches(lease.holderIdentity, args.holder)
	) {
		throw new RunHolderLostError();
	}
	return { appId: null };
}

function assertExpectedSessionProject(
	row: { project_id: string },
	expectedProjectId: string,
): void {
	if (row.project_id !== expectedProjectId) {
		throw new AppProjectChangedError();
	}
}

function requireActiveBuildSession(row: LockedSessionRow): void {
	if (row.mode !== "build") {
		throw new DesignSessionStateError(
			"edit_mode_holds_no_run",
			"An edit design session never holds its own run: the bound app row is the only run and credit authority.",
		);
	}
	if (row.state !== "active") {
		throw new DesignSessionStateError(
			"not_active",
			`This design session is ${row.state}, so it cannot claim a run.`,
		);
	}
}

/** Fire the reapers the admission scan surfaced — AFTER the claim
 * transaction committed, exactly like the app claim's post-commit reaps. */
function fireScanReaps(reapable: readonly ReapableGenerationTarget[]): void {
	for (const target of reapable) {
		if (target.kind === "app") {
			void reapStaleGenerating(target.appId, target.identity);
		} else {
			void reapStaleDesignSessionRun(target.designSessionId, target.identity);
		}
	}
}

// ── Creation ───────────────────────────────────────────────────────

/**
 * Create AND claim a fresh BUILD design session — creation, the cross-target
 * concurrency check, affordability, the reservation, and the holder write in
 * ONE gated transaction (§11.13 rule 2: actor gate → membership gate/member
 * row → insert). Two concurrent new-session requests for one actor serialize
 * on the gate, and the loser's scan sees the winner's live holder — they can
 * never both hold. Every rejection is a rollback that created nothing.
 *
 * The session id and proposed app id are server-minted OUTSIDE the retryable
 * transaction so a serialization retry reuses them.
 */
export async function createAndClaimDesignSessionRun(args: {
	projectId: string;
	actorUserId: string;
	runId: string;
	cost: number;
	holderNonce?: string;
}): Promise<CreatedDesignSessionRun> {
	const designSessionId = crypto.randomUUID();
	const proposedAppId = crypto.randomUUID();
	const holderNonce = args.holderNonce ?? crypto.randomUUID();
	const period = getCurrentPeriod();
	const reapable: ReapableGenerationTarget[] = [];
	await withAppTx(async (tx) => {
		reapable.length = 0;
		await lockActorGenerationGate(tx, args.actorUserId);
		await assertProjectCapabilityInTransaction(
			tx,
			args.actorUserId,
			args.projectId,
			"edit",
			"You don't have permission to start a design in this Project.",
		);
		const scan = await scanActorGenerationTargets(tx, args.actorUserId);
		reapable.push(...scan.reapable);
		if (scan.live) throw new GenerationInProgressError();
		await debitForDesignSessionReservation(tx, {
			userId: args.actorUserId,
			cost: args.cost,
			period,
			priorMarker: undefined,
			owner: args.actorUserId,
		});
		await tx
			.insertInto("design_sessions")
			.values({
				id: designSessionId,
				mode: "build",
				project_id: args.projectId,
				owner_user_id: args.actorUserId,
				proposed_app_id: proposedAppId,
				app_id: null,
				state: "active",
				awaiting_input: false,
				run_id: args.runId,
				run_holder_nonce: holderNonce,
				run_actor_user_id: args.actorUserId,
				run_mode: "build",
				run_lease_expires_at: new Date(designSessionLeaseDeadlineMs()),
				res_period: period,
				res_reserved: args.cost,
				res_settled: false,
				res_user_id: args.actorUserId,
				res_run_id: args.runId,
				last_error_type: null,
			})
			.execute();
	});
	fireScanReaps(reapable);
	return {
		designSessionId,
		proposedAppId,
		reservation: { period, reserved: args.cost },
		holderNonce,
	};
}

/**
 * Create an EDIT design session — a design-aware edit's artifact scope,
 * bound to its app. No holder, no reservation, no pause flag can ever land
 * on it (the table CHECKs); the app's run protocol stays the sole authority.
 */
export async function createEditDesignSession(args: {
	appId: string;
	projectId: string;
	actorUserId: string;
}): Promise<{ designSessionId: string }> {
	const designSessionId = crypto.randomUUID();
	await withAppTx(async (tx) => {
		await lockActorGenerationGate(tx, args.actorUserId);
		/* The session's tenancy must agree with its bound app's BY
		 * CONSTRUCTION (§18.14 keeps them in lockstep on a Project move, but
		 * the move's UPDATE only re-tenants rows that exist — a session
		 * inserted from a pre-move authorization snapshot would be born
		 * diverged and never repaired). Hold the app row FOR SHARE so a
		 * concurrent move serializes against this insert, and reject a
		 * caller whose snapshot the move already invalidated. */
		const app = await tx
			.selectFrom("apps")
			.select(["id", "project_id"])
			.where("id", "=", args.appId)
			.forShare()
			.executeTakeFirst();
		if (!app) throw new AppProjectChangedError();
		if (app.project_id !== args.projectId) throw new AppProjectChangedError();
		await assertProjectCapabilityInTransaction(
			tx,
			args.actorUserId,
			args.projectId,
			"edit",
			"You don't have permission to start a design in this Project.",
		);
		await tx
			.insertInto("design_sessions")
			.values({
				id: designSessionId,
				mode: "edit",
				project_id: args.projectId,
				owner_user_id: args.actorUserId,
				proposed_app_id: null,
				app_id: args.appId,
				state: "active",
				awaiting_input: false,
				last_error_type: null,
			})
			.execute();
	});
	return { designSessionId };
}

// ── Claim / resume ─────────────────────────────────────────────────

/**
 * Claim an EXISTING build session's run window AND reserve its credits —
 * the design-session twin of `claimAndReserveRun`, for a later chargeable
 * turn (a re-drive of a failed/reaped session, a new instruction after a
 * completed conversational round). Same busy semantics: a live holder or
 * ANOTHER actor's paused round conflicts; the claimant's OWN paused round is
 * superseded (its unsettled hold refunds inside the debit). Pre-app mode is
 * `build` only — an edit session rejects (`DesignSessionStateError`).
 */
export async function claimAndReserveDesignSessionRun(
	designSessionId: string,
	runId: string,
	actorUserId: string,
	cost: number,
	expectedProjectId: string,
	holderNonce: string = crypto.randomUUID(),
): Promise<ClaimedDesignSessionRun> {
	const period = getCurrentPeriod();
	const reapable: ReapableGenerationTarget[] = [];
	try {
		const claimed = await withAppTx(async (tx) => {
			reapable.length = 0;
			await lockActorGenerationGate(tx, actorUserId);
			const row = await lockSessionRow(tx, designSessionId);
			if (!row) {
				throw new DesignSessionStateError(
					"not_found",
					"This design session no longer exists.",
				);
			}
			requireActiveBuildSession(row);
			assertExpectedSessionProject(row, expectedProjectId);
			if (row.owner_user_id !== actorUserId) {
				throw new DesignSessionStateError(
					"not_found",
					"This design session no longer exists.",
				);
			}
			await assertProjectCapabilityInTransaction(
				tx,
				actorUserId,
				row.project_id,
				"edit",
				"You no longer have edit access to this design's Project.",
			);
			const lease = designSessionLeaseState(row);
			if (lease.live || (lease.paused && !lease.pausedBy(actorUserId))) {
				throw new RunConflictError(
					lease.reapableStaleRun,
					false,
					toExactRunHolderIdentity(lease.holderIdentity),
					"Another request is already working on this design, only one run can work on a design at a time.",
				);
			}
			const scan = await scanActorGenerationTargets(tx, actorUserId, {
				designSessionId,
			});
			reapable.push(...scan.reapable);
			if (scan.live) throw new GenerationInProgressError();
			await debitForDesignSessionReservation(tx, {
				userId: actorUserId,
				cost,
				period,
				priorMarker: designSessionReservation(row),
				owner: row.owner_user_id,
			});
			await tx
				.updateTable("design_sessions")
				.set({
					awaiting_input: false,
					run_id: runId,
					run_holder_nonce: holderNonce,
					run_actor_user_id: actorUserId,
					run_mode: "build",
					run_lease_expires_at: new Date(designSessionLeaseDeadlineMs()),
					res_period: period,
					res_reserved: cost,
					res_settled: false,
					res_user_id: actorUserId,
					res_run_id: runId,
					last_error_type: null,
					updated_at: new Date(),
				})
				.where("id", "=", designSessionId)
				.execute();
			return { reservation: { period, reserved: cost }, holderNonce };
		});
		fireScanReaps(reapable);
		return claimed;
	} catch (err) {
		/* A conflict with a REAPABLE holder — an abandoned run whose lease
		 * lapsed. Reap on the waiter's own path (awaited) so its next poll
		 * deterministically finds the session freed, like the app claim. */
		if (err instanceof RunConflictError && err.reapableIdentity !== null) {
			if (err.reapableStaleBuild) {
				await reapStaleDesignSessionRun(designSessionId, err.reapableIdentity);
			}
		}
		throw err;
	}
}

export type DesignSessionReacquireResult =
	| { readonly outcome: "owned"; readonly holderNonce: string }
	| {
			readonly outcome: "superseded" | "released" | "refresh_required";
	  };

/**
 * Re-acquire a paused design-session run for a free continuation — the twin
 * of `reacquireLease`: prove the pause's exact run + actor BEFORE the nonce
 * (so a stale tab reads "refresh required" while a genuinely superseded or
 * reaped round reads the truth), then renew the lease + clear the pause
 * atomically. A lost resume touches nothing.
 */
export async function reacquireDesignSessionLease(
	designSessionId: string,
	runId: string,
	presentedHolderNonce: string | null,
	actorUserId: string,
	expectedProjectId: string,
): Promise<DesignSessionReacquireResult> {
	return await withAppTx(async (tx) => {
		await lockActorGenerationGate(tx, actorUserId);
		const row = await lockSessionRow(tx, designSessionId);
		if (row?.state !== "active") return { outcome: "released" };
		assertExpectedSessionProject(row, expectedProjectId);
		if (row.owner_user_id !== actorUserId) return { outcome: "released" };
		await assertProjectCapabilityInTransaction(
			tx,
			actorUserId,
			row.project_id,
			"edit",
			"You no longer have edit access to this design's Project.",
		);
		const lease = designSessionLeaseState(row);
		if (!lease.ownedByResume(runId, actorUserId, null, false)) {
			return { outcome: lease.present ? "superseded" : "released" };
		}
		if (
			presentedHolderNonce === null ||
			!lease.ownedByResume(runId, actorUserId, presentedHolderNonce, true)
		) {
			return { outcome: "refresh_required" };
		}
		const expectedHolder = {
			mode: "build",
			runId,
			nonce: presentedHolderNonce,
		} as const;
		const result = await tx
			.updateTable("design_sessions")
			.set({
				awaiting_input: false,
				run_lease_expires_at: new Date(designSessionLeaseDeadlineMs()),
				updated_at: new Date(),
			})
			.where("id", "=", designSessionId)
			.where(
				expectedPausedDesignSessionResumePredicate(expectedHolder, actorUserId),
			)
			.executeTakeFirst();
		return updatedExactlyOne(result)
			? { outcome: "owned", holderNonce: presentedHolderNonce }
			: { outcome: "superseded" };
	});
}

// ── Heartbeat / pause ──────────────────────────────────────────────

/**
 * Refresh a live design-session run's lease off SA activity — the build
 * heartbeat. An unchanged-holder write: NO actor gate, row-first, exactly
 * like the app heartbeats. Ownership-gated; a superseded run never extends
 * the taker's lease.
 */
export async function refreshDesignSessionLiveness(
	designSessionId: string,
	runId: string,
	holderNonce: string,
): Promise<void> {
	await withAppTx(async (tx) => {
		const row = await lockSessionRow(tx, designSessionId);
		if (!row) return;
		const lease = designSessionLeaseState(row);
		const expectedHolder = {
			mode: "build",
			runId,
			nonce: holderNonce,
		} as const;
		if (!exactRunHolderMatches(lease.holderIdentity, expectedHolder)) return;
		await tx
			.updateTable("design_sessions")
			.set({
				run_lease_expires_at: new Date(designSessionLeaseDeadlineMs()),
				updated_at: new Date(),
			})
			.where("id", "=", designSessionId)
			.where(expectedDesignSessionHolderPredicate(expectedHolder))
			.execute();
	});
}

export type DesignSessionPauseOutcome = "owned" | "superseded" | "released";

/**
 * Set or clear a design-session run's `awaiting_input` pause — the twin of
 * `setAwaitingInput`. Clearing re-arms the lease (the flag is what spared a
 * paused run from reaping; removing it must hand the resuming run a fresh
 * window); setting deliberately does not extend it, so an abandoned pause
 * lapses for the reaper. Project scope and fresh edit membership are checked
 * after the lock, matching resume admission.
 */
export async function setDesignSessionAwaitingInput(
	designSessionId: string,
	runId: string,
	holderNonce: string,
	awaiting: boolean,
	actorUserId: string,
	expectedProjectId: string,
): Promise<DesignSessionPauseOutcome> {
	return await withAppTx(async (tx) => {
		await lockActorGenerationGate(tx, actorUserId);
		const row = await lockSessionRow(tx, designSessionId);
		if (row?.state !== "active") return "released";
		assertExpectedSessionProject(row, expectedProjectId);
		if (row.owner_user_id !== actorUserId) return "released";
		await assertProjectCapabilityInTransaction(
			tx,
			actorUserId,
			row.project_id,
			"edit",
			"You no longer have edit access to this design's Project.",
		);
		const lease = designSessionLeaseState(row);
		const expectedHolder = {
			mode: "build",
			runId,
			nonce: holderNonce,
		} as const;
		if (!exactRunHolderMatches(lease.holderIdentity, expectedHolder)) {
			return lease.present ? "superseded" : "released";
		}
		const result = await tx
			.updateTable("design_sessions")
			.set(
				awaiting
					? { awaiting_input: true, updated_at: new Date() }
					: {
							awaiting_input: false,
							run_lease_expires_at: new Date(designSessionLeaseDeadlineMs()),
							updated_at: new Date(),
						},
			)
			.where("id", "=", designSessionId)
			.where(expectedDesignSessionHolderPredicate(expectedHolder))
			.executeTakeFirst();
		return updatedExactlyOne(result) ? "owned" : "superseded";
	});
}

// ── Terminal writers ───────────────────────────────────────────────

export type DesignSessionTerminalOutcome = "owned" | "superseded" | "released";

/**
 * Clean design-session run completion — the twin of `completeAndSettleRun`:
 * the kept charge and the release commit together. On a session, "settle and
 * keep the charge" IS the authority release: the month row stays debited and
 * the marker leaves with the holder (a marker never outlives its holder
 * here), so a later flush refund finds no owned marker and no-ops — the same
 * post-completion posture an app's settled marker produces. The session
 * stays `active`: a question-only conversational run leaves no app and the
 * session remains resumable; materialization is the separate authority
 * transfer that moves it to `materialized`.
 */
export async function completeAndSettleDesignSessionRun(
	designSessionId: string,
	runId: string,
	holderNonce: string,
): Promise<DesignSessionTerminalOutcome> {
	return await withAppTx(async (tx) => {
		await lockActorGenerationGateForSessionHolder(tx, designSessionId);
		const row = await lockSessionRow(tx, designSessionId);
		if (!row) return "released";
		const lease = designSessionLeaseState(row);
		const expectedHolder = {
			mode: "build",
			runId,
			nonce: holderNonce,
		} as const;
		if (
			!exactRunHolderMatches(lease.holderIdentity, expectedHolder) ||
			!lease.terminalWriteOwned(runId)
		) {
			return lease.present ? "superseded" : "released";
		}
		const result = await tx
			.updateTable("design_sessions")
			.set({
				...designSessionAuthorityCleared(),
				last_error_type: null,
				updated_at: new Date(),
			})
			.where("id", "=", designSessionId)
			.where(expectedDesignSessionHolderPredicate(expectedHolder))
			.executeTakeFirst();
		return updatedExactlyOne(result) ? "owned" : "superseded";
	});
}

/**
 * The FAILED design-session run's terminal writer — refund-if-unsettled +
 * release + `last_error_type`, one transaction
 * (`settleAndReleaseDesignSessionRun` in `credits.ts` is the body). The
 * returned `settled` answers "does this admitted holder still own the
 * outcome"; a reaped ghost has no terminal authority.
 */
export async function failAndRefundDesignSessionRun(
	designSessionId: string,
	runId: string,
	holderNonce: string,
	errorType: string,
): Promise<{ settled: boolean; outcome: DesignSessionTerminalOutcome }> {
	return await settleAndReleaseDesignSessionRun(
		designSessionId,
		runId,
		holderNonce,
		errorType,
	);
}

/**
 * Reap a stale design-session run: refund the stranded hold + release the
 * authority state, staleness re-validated in-transaction
 * (`refundStaleDesignSessionRun`). Idempotent; fire-and-forget at scan call
 * sites and awaited from a claim's conflict nudge.
 */
export async function reapStaleDesignSessionRun(
	designSessionId: string,
	expectedIdentity: ExactRunHolderIdentity,
): Promise<void> {
	try {
		if (expectedIdentity.mode !== "build") return;
		await refundStaleDesignSessionRun(designSessionId, expectedIdentity);
	} catch (err) {
		log.error("[reapStaleDesignSessionRun] stale-run reap failed", err, {
			designSessionId,
		});
	}
}

// ── Discard ────────────────────────────────────────────────────────

/** Thrown when a discard races a live (or another actor's paused) run. */
export class DesignSessionBusyError extends Error {
	readonly name = "DesignSessionBusyError";
	constructor() {
		super(
			"A run is still working on this design. Wait for it to finish (or pause), then discard.",
		);
	}
}

/**
 * Discard a pre-app BUILD design session (§11.12): exact user ownership +
 * current Project edit permission, refused while a live holder (or another
 * actor's paused round) owns the session, releasing/refunding any remaining
 * hold through the exact-holder policy, then `abandoned`. Transcript and
 * artifacts are retained per policy; no app is created or deleted.
 * Idempotent on an already-abandoned session.
 */
export async function discardDesignSession(
	designSessionId: string,
	actorUserId: string,
	expectedProjectId: string,
): Promise<{ outcome: "discarded" | "already_abandoned" }> {
	return await withAppTx(async (tx) => {
		await lockActorGenerationGate(tx, actorUserId);
		const row = await lockSessionRow(tx, designSessionId);
		if (!row) {
			throw new DesignSessionStateError(
				"not_found",
				"This design session no longer exists.",
			);
		}
		if (row.state === "abandoned") return { outcome: "already_abandoned" };
		if (row.mode !== "build" || row.state !== "active") {
			throw new DesignSessionStateError(
				row.mode !== "build" ? "not_build" : "not_active",
				"Only an active pre-app design can be discarded; a materialized or edit design follows its app's lifecycle.",
			);
		}
		assertExpectedSessionProject(row, expectedProjectId);
		await assertProjectCapabilityInTransaction(
			tx,
			actorUserId,
			row.project_id,
			"edit",
			"You no longer have edit access to this design's Project.",
		);
		if (row.owner_user_id !== actorUserId) {
			throw new DesignSessionStateError(
				"not_found",
				"Only the design's owner can discard it.",
			);
		}
		const lease = designSessionLeaseState(row);
		if (lease.live || (lease.paused && !lease.pausedBy(actorUserId))) {
			throw new DesignSessionBusyError();
		}
		const reservation = designSessionReservation(row);
		if (reservation && !reservation.settled && reservation.userId) {
			await refundToMonthInTransaction(
				tx,
				reservation.userId,
				reservation.period,
				reservation.reserved,
			);
		}
		/* No live holder may survive the busy guard above. Retire every mutable
		 * recovery carrier with the abandonment so a discarded design cannot
		 * leave an apparently resumable workspace, attempt, or stream marker. */
		await tx
			.updateTable("design_change_sets")
			.set({ status: "abandoned", updated_at: new Date() })
			.where("design_session_id", "=", designSessionId)
			.where("status", "=", "open")
			.execute();
		await tx
			.updateTable("design_slice_attempts")
			.set({
				status: "superseded",
				failure_code: "design-session-abandoned",
				updated_at: new Date(),
			})
			.where("design_session_id", "=", designSessionId)
			.where("status", "=", "running")
			.execute();
		await tx
			.updateTable("threads")
			.set({
				active_stream_id: null,
				active_holder_nonce: null,
				updated_at: new Date().toISOString(),
			})
			.where("design_session_id", "=", designSessionId)
			.execute();
		await tx
			.updateTable("design_sessions")
			.set({
				...designSessionAuthorityCleared(),
				state: "abandoned",
				updated_at: new Date(),
			})
			.where("id", "=", designSessionId)
			.execute();
		return { outcome: "discarded" };
	});
}

/**
 * Point the session at its accepted design revision and active build plan —
 * the explicit selection §18.4 requires (never "latest timestamp"). The
 * delegated session/app authority carrier, current membership, and complete
 * same-session accepted lineage are proved in the update transaction.
 */
export async function setDesignSessionActiveArtifacts(args: {
	designSessionId: string;
	actorUserId: string;
	runId: string;
	holderNonce: string;
	expectedProjectId: string;
	activeDesignRevisionId: string;
	activeBuildPlanId: string;
}): Promise<void> {
	await withAppTx(async (tx) => {
		await setDesignSessionActiveArtifactsInTransaction(tx, args);
	});
}

/** The active-artifact selection transaction body. The authority carrier,
 * membership, accepted revision, and same-session plan are proved here so a
 * caller that also transitions execution control can make both writes one
 * atomic decision. */
export async function setDesignSessionActiveArtifactsInTransaction(
	tx: Transaction<AppDatabase>,
	args: {
		designSessionId: string;
		actorUserId: string;
		runId: string;
		holderNonce: string;
		expectedProjectId: string;
		activeDesignRevisionId: string;
		activeBuildPlanId: string;
	},
): Promise<void> {
	await assertDesignSessionRunAuthorityInTransaction(tx, {
		designSessionId: args.designSessionId,
		actorUserId: args.actorUserId,
		expectedProjectId: args.expectedProjectId,
		holder: {
			mode: "build",
			runId: args.runId,
			nonce: args.holderNonce,
		},
	});
	const revision = await tx
		.selectFrom("design_revisions")
		.select(["id", "design_session_id", "lifecycle"])
		.where("id", "=", args.activeDesignRevisionId)
		.executeTakeFirst();
	const plan = await tx
		.selectFrom("design_build_plans")
		.select(["id", "design_session_id", "design_revision_id"])
		.where("id", "=", args.activeBuildPlanId)
		.executeTakeFirst();
	if (
		revision === undefined ||
		revision.design_session_id !== args.designSessionId ||
		revision.lifecycle !== "accepted" ||
		plan === undefined ||
		plan.design_session_id !== args.designSessionId ||
		plan.design_revision_id !== revision.id
	) {
		throw new DesignSessionStateError(
			"not_found",
			"The selected design revision and build plan do not form one accepted lineage in this session.",
		);
	}
	await tx
		.updateTable("design_sessions")
		.set({
			active_design_revision_id: args.activeDesignRevisionId,
			active_build_plan_id: args.activeBuildPlanId,
			updated_at: new Date(),
		})
		.where("id", "=", args.designSessionId)
		.execute();
}

// ── Loads ──────────────────────────────────────────────────────────

/** Load one design session, or null. Authorization is the caller's job
 * (the generation-target resolver collapses denials opaquely). */
export async function loadDesignSession(
	designSessionId: string,
): Promise<DesignSessionDoc | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_sessions")
		.select([
			...SESSION_LEASE_SELECT,
			"active_design_revision_id",
			"active_build_plan_id",
		])
		.where("id", "=", designSessionId)
		.executeTakeFirst();
	if (!row) return null;
	return {
		id: row.id,
		mode: parsePersistedDesignSessionMode(row.mode),
		project_id: row.project_id,
		owner_user_id: row.owner_user_id,
		proposed_app_id: row.proposed_app_id,
		app_id: row.app_id,
		state: parsePersistedDesignSessionState(row.state),
		awaiting_input: row.awaiting_input,
		run_id: row.run_id,
		run_holder_nonce: row.run_holder_nonce,
		run_actor_user_id: row.run_actor_user_id,
		run_lease_expires_at: row.run_lease_expires_at,
		last_error_type: row.last_error_type,
		active_design_revision_id: row.active_design_revision_id ?? null,
		active_build_plan_id: row.active_build_plan_id ?? null,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

/** The MATERIALIZED build session bound to an app, or null — how an
 *  app-target build turn (a re-drive of an interrupted design build) finds
 *  the orchestration scope its run resumes. At most one exists: `app_id` is
 *  write-once at materialization. */
export async function loadMaterializedSessionForApp(
	appId: string,
): Promise<DesignSessionDoc | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_sessions")
		.select(["id"])
		.where("app_id", "=", appId)
		.where("state", "=", "materialized")
		.executeTakeFirst();
	if (!row) return null;
	return loadDesignSession(row.id);
}

/** Whether ANY run currently holds this design session live — the stream
 * endpoint's dead-run fallback signal, the session twin of `appHeldLive`. */
export async function designSessionHeldLive(
	designSessionId: string,
): Promise<boolean> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_sessions")
		.select([...SESSION_LEASE_SELECT])
		.where("id", "=", designSessionId)
		.executeTakeFirst();
	if (!row) return false;
	return designSessionLeaseState(row as DesignSessionLeaseRow).live;
}
