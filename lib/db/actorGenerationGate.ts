// The per-actor cross-target generation admission gate.
//
// One actor's chargeable generations are admitted against a policy that
// spans BOTH target kinds (apps and design sessions): "one live build at a
// time" can only be decided atomically if every transaction that creates,
// releases, pauses, resumes, settles, refunds, reaps, or transfers a
// holder/reservation for that actor serializes on ONE lock — a plain SELECT
// across `apps` and `design_sessions` is race-prone, and two concurrent new
// design sessions could otherwise both reserve.
//
// The gate is a transaction-scoped advisory lock in PostgreSQL's 64-bit
// keyspace (a DIFFERENT keyspace from the two-int32 form the Project
// membership gate uses, so the two gates cannot interact). The key derives
// from a versioned hash namespace plus the actor's user id; the derivation
// is pinned by golden vectors in `__tests__/actorGenerationGate.postgres.test.ts`.
//
// LOCK ORDER — the one deliberate amendment to the app-row-first
// convention: for holder/reservation LIFECYCLE transitions (create, claim,
// reacquire, pause, settle, refund, reap, transfer) the actor gate is the
// FIRST lock, before the authority row (`apps` or `design_sessions`), then
// the membership gate/member row, then credit/dependent rows. Canonical app
// commits and writes that merely verify an unchanged holder (heartbeats,
// thread writes) take NO actor gate and keep authority-row-first ordering.
// Applying the gate after an app row on one path and before a
// design-session row on another would permit a gate↔row deadlock during
// cross-target reap/admission; gate-first on every lifecycle path removes
// the cycle, and one transaction never takes two actors' gates.
//
// This module also owns the cross-target admission SCAN the gate
// serializes: the actor's live builds across `apps` AND `design_sessions`,
// with the reapable stale holders it finds carried back for the caller to
// reap AFTER its transaction commits (the scan itself is side-effect free).

import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { LEASE_COLUMNS, leaseView } from "./leaseView";
import type { AppDatabase } from "./pg";
import {
	type ExactRunHolderIdentity,
	toExactRunHolderIdentity,
} from "./runHolderWrites";
import { designSessionLeaseState, runLeaseState } from "./runLiveness";

/** Versioned derivation namespace. Bumping the version re-keys every gate,
 * which is only safe when no two revisions serialize the same actors — treat
 * it like a lock-table rename, not a tunable. */
const GATE_KEY_NAMESPACE = "nova:actor-generation-admission:v1:";

/**
 * Derive the 64-bit advisory key for one actor: the first 8 bytes of
 * SHA-256 over the versioned namespace + actor user id, read big-endian as
 * a SIGNED int64 (PostgreSQL bigint). Deterministic across processes; a
 * cross-actor collision only over-serializes and cannot affect correctness.
 */
export function actorGenerationGateKey(actorUserId: string): bigint {
	if (actorUserId.length === 0) {
		throw new Error(
			"The actor generation gate needs a nonblank actor user id.",
		);
	}
	const digest = createHash("sha256")
		.update(GATE_KEY_NAMESPACE + actorUserId, "utf8")
		.digest();
	return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}

/**
 * Hold the actor's generation-admission gate for the caller's current
 * transaction. MUST be the transaction's first lock on every
 * holder/reservation lifecycle path — see the module doc's lock order.
 */
export async function lockActorGenerationGate(
	tx: Transaction<AppDatabase>,
	actorUserId: string,
): Promise<void> {
	await sql`
		SELECT pg_catalog.pg_advisory_xact_lock(
			${actorGenerationGateKey(actorUserId).toString()}::bigint
		)
	`.execute(tx);
}

/**
 * Gate a lifecycle transaction whose actor is the CURRENT HOLDER of an app
 * row (settle/refund/release/reap paths, whose callers carry only the
 * holder token). The actor derives from an unlocked pre-read — build holds
 * charge to `res_user_id` (falling back to `owner`), edit holds to
 * `lock_actor_user_id` — and a pre-read that goes stale is harmless: the
 * writer's exact-holder compare-and-set already no-ops, and holding a
 * different actor's gate serializes nothing incorrect. A missing row takes
 * no gate (there is nothing to serialize).
 */
export async function lockActorGenerationGateForAppHolder(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<void> {
	const row = await tx
		.selectFrom("apps")
		.select(["status", "owner", "res_user_id", "lock_actor_user_id"])
		.where("id", "=", appId)
		.executeTakeFirst();
	if (!row) return;
	const actor =
		row.status === "generating"
			? (row.res_user_id ?? row.owner)
			: (row.lock_actor_user_id ?? row.res_user_id ?? row.owner);
	if (!actor) return;
	await lockActorGenerationGate(tx, actor);
}

/**
 * The design-session twin of {@link lockActorGenerationGateForAppHolder}:
 * gate on the session's holding actor (falling back to its owner), from an
 * unlocked pre-read, before the session row is locked.
 */
export async function lockActorGenerationGateForSessionHolder(
	tx: Transaction<AppDatabase>,
	designSessionId: string,
): Promise<void> {
	const row = await tx
		.selectFrom("design_sessions")
		.select(["owner_user_id", "run_actor_user_id"])
		.where("id", "=", designSessionId)
		.executeTakeFirst();
	if (!row) return;
	await lockActorGenerationGate(tx, row.run_actor_user_id ?? row.owner_user_id);
}

/** One reapable stale holder the admission scan surfaced, tagged by the
 * target kind so the caller can fire the matching reaper post-commit. */
export type ReapableGenerationTarget =
	| { kind: "app"; appId: string; identity: ExactRunHolderIdentity }
	| {
			kind: "design-session";
			designSessionId: string;
			identity: ExactRunHolderIdentity;
	  };

export interface ActorGenerationScan {
	live: boolean;
	reapable: ReapableGenerationTarget[];
}

/** The design-session slice of the admission scan (the columns
 * `designSessionLeaseState` reads). */
export const DESIGN_SESSION_LEASE_COLUMNS = [
	"id",
	"state",
	"awaiting_input",
	"owner_user_id",
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
	"updated_at",
] as const;

/**
 * Whether the ACTOR has a live build in progress on any OTHER generation
 * target — the cross-target "one build at a time per user" scan, across
 * `apps` (the historical arm, byte-identical) and `design_sessions`.
 * Side-effect free: reapable stale holders are returned for the caller to
 * reap AFTER its transaction commits. Meaningful only under the actor's
 * generation gate (or as an advisory standalone read).
 */
export async function scanActorGenerationTargets(
	db: Pick<Transaction<AppDatabase>, "selectFrom">,
	actorUserId: string,
	exclude?: { appId?: string; designSessionId?: string },
): Promise<ActorGenerationScan> {
	const now = Date.now();
	const reapable: ReapableGenerationTarget[] = [];
	let live = false;

	let appQuery = db
		.selectFrom("apps")
		.select(["id", ...LEASE_COLUMNS])
		.where("deleted_at", "is", null)
		.where("status", "=", "generating")
		.where((eb) =>
			eb.or([
				eb("owner", "=", actorUserId),
				eb("res_user_id", "=", actorUserId),
			]),
		)
		/* Freshest first, so a LIVE build is never paged out of the LIMIT by an
		 * accumulation of stale un-reaped rows. */
		.orderBy("updated_at", "desc")
		.limit(10);
	if (exclude?.appId !== undefined) {
		appQuery = appQuery.where("id", "!=", exclude.appId);
	}
	const appRows = await appQuery.execute();
	for (const row of appRows) {
		/* A co-member's run on THIS user's owned app is the co-member's
		 * concurrency, not this user's. A marker-less owner match (the new-build
		 * window) has no run actor yet and is kept. */
		const runActor = row.res_user_id ?? undefined;
		if (runActor !== undefined && runActor !== actorUserId) continue;
		const lease = runLeaseState(leaseView(row), now);
		if (lease.live) live = true;
		else if (lease.reapableStaleBuild) {
			const identity = toExactRunHolderIdentity(lease.holderIdentity);
			if (identity !== null) {
				reapable.push({ kind: "app", appId: row.id, identity });
			}
		}
	}

	let sessionQuery = db
		.selectFrom("design_sessions")
		.select([...DESIGN_SESSION_LEASE_COLUMNS])
		.where("state", "=", "active")
		.where("run_id", "is not", null)
		.where("run_actor_user_id", "=", actorUserId)
		.orderBy("updated_at", "desc")
		.limit(10);
	if (exclude?.designSessionId !== undefined) {
		sessionQuery = sessionQuery.where("id", "!=", exclude.designSessionId);
	}
	const sessionRows = await sessionQuery.execute();
	for (const row of sessionRows) {
		const lease = designSessionLeaseState(row, now);
		if (lease.live) live = true;
		else if (lease.reapableStaleRun) {
			const identity = toExactRunHolderIdentity(lease.holderIdentity);
			if (identity !== null) {
				reapable.push({
					kind: "design-session",
					designSessionId: row.id,
					identity,
				});
			}
		}
	}

	return { live, reapable };
}
