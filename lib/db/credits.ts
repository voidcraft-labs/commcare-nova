/**
 * Credit ledger — the SERVER side of the credit gate, on Postgres.
 *
 * The pure constants and cost rules live in `./creditPolicy` (dependency-free,
 * client-safe); the IO lives here. The reservation debit itself
 * (`debitAndBookReservation`) is an IN-TRANSACTION helper the claim owns:
 * `claimAndReserveRun` / `reserveForNewBuild` (`./apps`) lock the app row and
 * call it, so the busy check, the leftover refund, the affordability check,
 * the debit, and the claim writes commit as ONE transaction — an app that is
 * claimed always carries its claimant's marker.
 *
 * Lock ordering: every transaction here locks the APP row first (the caller
 * already holds it, or the terminal writers/reapers take it themselves), then
 * touches `credit_months` rows — one consistent order, no deadlock cycles.
 */
import type { Transaction } from "kysely";
import { creditBalance, MONTHLY_CREDIT_ALLOWANCE } from "./creditPolicy";
import {
	LEASE_COLUMNS,
	type LeaseRow,
	leaseView,
	rowReservation,
} from "./leaseView";
import { getCurrentPeriod } from "./period";
import { type AppDatabase, getAppDb, withAppTx } from "./pg";
import {
	type ExactRunHolderIdentity,
	exactRunHolderMatches,
	expectedRunHolderPredicate,
	updatedExactlyOne,
} from "./runHolderWrites";
import { runLeaseState } from "./runLiveness";
import type { AppReservation, CreditGrantDoc } from "./types";

/**
 * Thrown when the user's remaining balance can't cover the charge. The chat
 * route maps this to a 429 out-of-credits; every other reservation failure is
 * an infrastructure fault the route fails closed on. Raised INSIDE the claim
 * transaction, so the whole claim rolls back — nothing to restore.
 */
export class OutOfCreditsError extends Error {
	constructor() {
		super("Out of credits for this period");
		this.name = "OutOfCreditsError";
	}
}

/**
 * The booked reservation handed back to the route, then threaded into the
 * usage accumulator so a no-op or failed run can refund the exact charge
 * against the exact month it hit (a flush that crosses midnight un-books the
 * month that was actually debited).
 */
export interface Reservation {
	period: string;
	reserved: number;
}

/** A conditional holder write lost its exact compare-and-set. Throwing rolls
 * back any credit-row refund already made in the same transaction. */
class RunHolderWriteConflictError extends Error {
	constructor(operation: string) {
		super(`${operation} lost exact run-holder ownership`);
		this.name = "RunHolderWriteConflictError";
	}
}

function requireExactHolderWrite(
	operation: string,
	result: { readonly numUpdatedRows: bigint },
): void {
	if (!updatedExactlyOne(result)) {
		throw new RunHolderWriteConflictError(operation);
	}
}

/** Lock + read one app's liveness slice inside a refund transaction. */
async function lockLeaseRow(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<LeaseRow | undefined> {
	return (await tx
		.selectFrom("apps")
		.select(LEASE_COLUMNS)
		.where("id", "=", appId)
		.forUpdate()
		.executeTakeFirst()) as LeaseRow | undefined;
}

/** Read a credit-month row under lock; absent rows read as the defaults. */
async function lockCreditMonth(
	tx: Transaction<AppDatabase>,
	userId: string,
	period: string,
): Promise<{ allowance: number; consumed: number; bonus: number } | undefined> {
	return await tx
		.selectFrom("credit_months")
		.select(["allowance", "consumed", "bonus"])
		.where("user_id", "=", userId)
		.where("period", "=", period)
		.forUpdate()
		.executeTakeFirst();
}

/**
 * Guarantee the month row EXISTS before a writer locks it. `SELECT … FOR
 * UPDATE` locks NOTHING when the row is absent, so two first-of-month writers
 * would each read absent-row defaults and the loser's upsert would clobber
 * the winner's committed write with a stale absolute value. Seeding the row
 * first (`ON CONFLICT DO NOTHING` — the second writer blocks on the first's
 * insert, then no-ops) makes the subsequent `FOR UPDATE` a real lock, so
 * every read-check-write here serializes exactly as documented.
 */
async function ensureCreditMonthRow(
	tx: Transaction<AppDatabase>,
	userId: string,
	period: string,
): Promise<void> {
	await tx
		.insertInto("credit_months")
		.values({
			user_id: userId,
			period,
			allowance: MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: 0,
			updated_at: new Date(),
		})
		.onConflict((oc) => oc.columns(["user_id", "period"]).doNothing())
		.execute();
}

/** Write a complete credit-month row (insert-or-update — every writer seeds
 *  `allowance` explicitly so a row is always complete). */
async function upsertCreditMonth(
	tx: Transaction<AppDatabase>,
	userId: string,
	period: string,
	values: { allowance: number; consumed: number; bonus: number },
): Promise<void> {
	await tx
		.insertInto("credit_months")
		.values({ user_id: userId, period, ...values, updated_at: new Date() })
		.onConflict((oc) =>
			oc.columns(["user_id", "period"]).doUpdateSet({
				allowance: values.allowance,
				consumed: values.consumed,
				bonus: values.bonus,
				updated_at: new Date(),
			}),
		)
		.execute();
}

/** Un-book `amount` from a user's month (clamped at 0) — the shared refund
 *  write. A missing row is a clean no-op (nothing was ever debited there). */
async function refundToMonth(
	tx: Transaction<AppDatabase>,
	userId: string,
	period: string,
	amount: number,
): Promise<void> {
	const row = await lockCreditMonth(tx, userId, period);
	if (!row) return;
	await tx
		.updateTable("credit_months")
		.set({
			consumed: Math.max(0, row.consumed - amount),
			updated_at: new Date(),
		})
		.where("user_id", "=", userId)
		.where("period", "=", period)
		.execute();
}

/**
 * The reservation debit — runs INSIDE the caller's claim transaction (the app
 * row is already locked). In order:
 *
 *  1. Refund a leftover UNSETTLED marker UNCONDITIONALLY — the caller only
 *     reaches here after winning the claim on a FREE app, so any unsettled
 *     marker present is a superseded (hard-killed) run's stranded hold.
 *     Refund targets the marker's own charged actor + period; when that is
 *     THIS run's own (user, period) it folds into the single debit below
 *     rather than a second write to the same row.
 *  2. Affordability: check the literal post-refund balance and throw
 *     `OutOfCreditsError` (rolling back the whole claim) if it can't cover
 *     the cost. The row is locked, so a concurrent reservation serializes
 *     behind this one and re-reads the depleted balance — the cap holds.
 *  3. Write the seeded month row (`consumed + cost`, explicit allowance) and
 *     book the fresh marker on the app row — the durable record every refund
 *     path reads (`userId` = the CHARGED actor; `runId` = the booking run).
 *
 * When the leftover refund and the debit touch TWO credit rows, both are
 * locked in one canonical order — ascending `(user_id, period)` — regardless
 * of which is the refund and which the debit, so two claims whose refund/debit
 * rows cross (a shared Project with superseded holds charged to each other's
 * actors) queue on the row locks instead of deadlocking.
 */
export async function debitAndBookReservation(
	tx: Transaction<AppDatabase>,
	args: {
		appId: string;
		userId: string;
		cost: number;
		runId: string;
		period: string;
		priorMarker: AppReservation | undefined;
		owner: string;
	},
): Promise<void> {
	const { appId, userId, cost, runId, period, priorMarker, owner } = args;

	let priorRefundSameRow = 0;
	let crossRefund: { user: string; period: string; amount: number } | undefined;
	if (priorMarker && !priorMarker.settled) {
		const priorUser = priorMarker.userId ?? owner;
		if (priorUser === userId && priorMarker.period === period) {
			priorRefundSameRow = priorMarker.reserved;
		} else {
			crossRefund = {
				user: priorUser,
				period: priorMarker.period,
				amount: priorMarker.reserved,
			};
		}
	}

	// Canonical lock order across the (up to) two credit rows this touches.
	const debitFirst =
		crossRefund === undefined ||
		userId < crossRefund.user ||
		(userId === crossRefund.user && period < crossRefund.period);
	let row: Awaited<ReturnType<typeof lockCreditMonth>>;
	await ensureCreditMonthRow(tx, userId, period);
	if (debitFirst) {
		row = await lockCreditMonth(tx, userId, period);
		if (crossRefund) {
			await refundToMonth(
				tx,
				crossRefund.user,
				crossRefund.period,
				crossRefund.amount,
			);
		}
	} else if (crossRefund) {
		await refundToMonth(
			tx,
			crossRefund.user,
			crossRefund.period,
			crossRefund.amount,
		);
		row = await lockCreditMonth(tx, userId, period);
	}

	const allowance = row?.allowance ?? MONTHLY_CREDIT_ALLOWANCE;
	const consumed = Math.max(0, (row?.consumed ?? 0) - priorRefundSameRow);
	const bonus = row?.bonus ?? 0;
	if (allowance + bonus - consumed < cost) {
		throw new OutOfCreditsError();
	}
	await upsertCreditMonth(tx, userId, period, {
		allowance,
		consumed: consumed + cost,
		bonus,
	});
	await tx
		.updateTable("apps")
		.set({
			res_period: period,
			res_reserved: cost,
			res_settled: false,
			res_user_id: userId,
			res_run_id: runId,
		})
		.where("id", "=", appId)
		.execute();
}

/**
 * Refund the credits a reservation booked AND atomically settle its marker —
 * the FLUSH path's refund (a failed / zero-cost run un-booking its OWN hold).
 * OWNERSHIP-GATED by the caller's exact `(mode, runId)` and
 * `terminalWriteOwned`: it no-ops when the holder is absent or different, so
 * it cannot claw a replacement run's live marker. Idempotent via `settled`;
 * refunds the CHARGED actor (`res_user_id`, falling back to `owner` for legacy
 * markers).
 */
export async function refundReservation(
	appId: string,
	runId: string,
	mode: "build" | "edit",
): Promise<void> {
	await withAppTx(async (tx) => {
		const row = await lockLeaseRow(tx, appId);
		if (!row) return;
		const lease = runLeaseState(leaseView(row));
		const expectedHolder = { mode, runId } as const;
		if (
			!exactRunHolderMatches(lease.holderIdentity, expectedHolder) ||
			!lease.terminalWriteOwned(runId)
		) {
			return;
		}
		const reservation = rowReservation(row);
		const chargedUserId = reservation?.userId ?? row.owner;
		if (!reservation || reservation.settled || !chargedUserId) return;
		await refundToMonth(
			tx,
			chargedUserId,
			reservation.period,
			reservation.reserved,
		);
		const result = await tx
			.updateTable("apps")
			.set({ res_settled: true })
			.where("id", "=", appId)
			.where(expectedRunHolderPredicate(expectedHolder))
			.executeTakeFirst();
		requireExactHolderWrite("refundReservation", result);
	});
}

/**
 * The FAILED-run terminal writer: refund-if-unsettled + settle the marker AND
 * (for an edit) release the `run_lock` — one transaction, so "lock cleared +
 * marker unsettled" is impossible by construction (a thrown transaction
 * changes nothing; the lock stays for `reapStaleReservation`).
 *
 * The RETURN (`settled`) answers the SEPARATE question "does this exact
 * `(mode, runId)` still own the outcome — safe for the route to `failApp`?":
 * true when that holder remains (whether flush pre-settled or this call
 * settles), false when it is absent or different. A reaped ghost therefore
 * has no terminal authority even before another run claims the app.
 */
export async function settleAndRelease(
	appId: string,
	runId: string,
	opts: { mode: "build" | "edit" },
): Promise<{ settled: boolean }> {
	return await withAppTx(async (tx) => {
		const row = await lockLeaseRow(tx, appId);
		if (!row) return { settled: false };
		const lease = runLeaseState(leaseView(row));
		const expectedHolder = { mode: opts.mode, runId } as const;
		if (!exactRunHolderMatches(lease.holderIdentity, expectedHolder)) {
			return { settled: false };
		}
		const reservation = rowReservation(row);
		const chargedUserId = reservation?.userId ?? row.owner;
		if (reservation && !reservation.settled && chargedUserId) {
			await refundToMonth(
				tx,
				chargedUserId,
				reservation.period,
				reservation.reserved,
			);
		}
		const settleField =
			reservation && !reservation.settled ? { res_settled: true } : {};
		const releaseField =
			opts.mode === "edit"
				? {
						lock_run_id: null,
						lock_actor_user_id: null,
						lock_expire_at: null,
					}
				: {};
		if (
			Object.keys(settleField).length + Object.keys(releaseField).length >
			0
		) {
			const result = await tx
				.updateTable("apps")
				.set({ ...settleField, ...releaseField })
				.where("id", "=", appId)
				.where(expectedRunHolderPredicate(expectedHolder))
				.executeTakeFirst();
			requireExactHolderWrite("settleAndRelease", result);
		}
		return { settled: true };
	});
}

/**
 * Refund a STRANDED edit hold — the edit reaper's transactional refund, with
 * the staleness RE-VALIDATED inside the transaction (`reapableStrandedEdit`
 * re-derived off the locked row), so a fresh edit that won the lapsed lock
 * between the scan and this refund is never clawed back. Settles the marker,
 * CLEARS its `runId` (the reaper's signature — the reaped run's own stale
 * terminal writer must not read it as `mine`), RELEASES the lapsed lock, and
 * clears `awaiting_input`, all in one commit. Idempotent via `settled`.
 */
export async function refundStaleReservation(
	appId: string,
	expectedHolder: ExactRunHolderIdentity,
): Promise<void> {
	await withAppTx(async (tx) => {
		const row = await lockLeaseRow(tx, appId);
		if (!row) return;
		const lease = runLeaseState(leaseView(row));
		if (
			expectedHolder.mode !== "edit" ||
			!exactRunHolderMatches(lease.holderIdentity, expectedHolder) ||
			!lease.reapableStrandedEdit
		) {
			return;
		}
		const reservation = rowReservation(row) as AppReservation;
		const chargedUserId = reservation.userId ?? row.owner;
		if (!chargedUserId) return;
		await refundToMonth(
			tx,
			chargedUserId,
			reservation.period,
			reservation.reserved,
		);
		const result = await tx
			.updateTable("apps")
			.set({
				res_settled: true,
				res_run_id: null,
				lock_run_id: null,
				lock_actor_user_id: null,
				lock_expire_at: null,
				awaiting_input: false,
			})
			.where("id", "=", appId)
			.where(expectedRunHolderPredicate(expectedHolder))
			.executeTakeFirst();
		requireExactHolderWrite("refundStaleReservation", result);
	});
}

/**
 * Reap a hard-killed BUILD: refund the stranded hold + flip
 * `generating → error` in ONE transaction, staleness RE-VALIDATED inside it
 * (`reapableStaleBuild` off the locked row — a re-claimed build reads live
 * and this no-ops). Clears the marker's `runId` (the reaper's signature) and
 * `awaiting_input` (an ABANDONED PAUSED build reaps with the distinct
 * `paused_timeout` classification — it expired waiting, it didn't crash).
 * A marker-less dead build with a concrete root `run_id` still flips to
 * `error` with no credit write; a missing holder identity fails closed.
 */
export async function refundStaleGeneration(
	appId: string,
	expectedHolder: ExactRunHolderIdentity,
): Promise<void> {
	await withAppTx(async (tx) => {
		const row = await lockLeaseRow(tx, appId);
		if (!row) return;
		const lease = runLeaseState(leaseView(row));
		if (
			expectedHolder.mode !== "build" ||
			!exactRunHolderMatches(lease.holderIdentity, expectedHolder) ||
			!lease.reapableStaleBuild
		) {
			return;
		}
		const reservation = rowReservation(row);
		const chargedUserId = reservation?.userId ?? row.owner;
		if (reservation && !reservation.settled && chargedUserId) {
			await refundToMonth(
				tx,
				chargedUserId,
				reservation.period,
				reservation.reserved,
			);
		}
		const result = await tx
			.updateTable("apps")
			.set({
				status: "error",
				error_type: row.awaiting_input ? "paused_timeout" : "internal",
				awaiting_input: false,
				...(reservation && !reservation.settled
					? { res_settled: true, res_run_id: null }
					: {}),
			})
			.where("id", "=", appId)
			.where(expectedRunHolderPredicate(expectedHolder))
			.executeTakeFirst();
		requireExactHolderWrite("refundStaleGeneration", result);
	});
}

/**
 * The acting admin behind a reset/grant, recorded on the audit row — the
 * single source of truth for this shape (the admin route builds it from the
 * session).
 */
export interface AdminActor {
	actor: string;
	actorEmail: string;
	reason: string | null;
}

/**
 * Reset a user's current-period credits: zero `consumed` and append the audit
 * row in ONE transaction, so the effect and its audit commit together. Seeds
 * a complete row (explicit allowance, preserved bonus) for a user with no
 * current-period row.
 */
export async function resetCredits(
	userId: string,
	who: AdminActor,
): Promise<void> {
	const period = getCurrentPeriod();
	await withAppTx(async (tx) => {
		await ensureCreditMonthRow(tx, userId, period);
		const row = await lockCreditMonth(tx, userId, period);
		await upsertCreditMonth(tx, userId, period, {
			allowance: row?.allowance ?? MONTHLY_CREDIT_ALLOWANCE,
			consumed: 0,
			bonus: row?.bonus ?? 0,
		});
		await tx
			.insertInto("credit_grants")
			.values({
				user_id: userId,
				amount: 0,
				type: "reset",
				actor: who.actor,
				actor_email: who.actorEmail,
				reason: who.reason,
				period,
			})
			.execute();
	});
}

/**
 * Grant a user bonus credits for the current period + the audit row, one
 * transaction. A grant ADDS to `bonus` and must never write `consumed` —
 * the row's stored usage is preserved verbatim.
 */
export async function grantCredits(
	userId: string,
	amount: number,
	who: AdminActor,
): Promise<void> {
	const period = getCurrentPeriod();
	await withAppTx(async (tx) => {
		await ensureCreditMonthRow(tx, userId, period);
		const row = await lockCreditMonth(tx, userId, period);
		await upsertCreditMonth(tx, userId, period, {
			allowance: row?.allowance ?? MONTHLY_CREDIT_ALLOWANCE,
			consumed: row?.consumed ?? 0,
			bonus: (row?.bonus ?? 0) + amount,
		});
		await tx
			.insertInto("credit_grants")
			.values({
				user_id: userId,
				amount,
				type: "grant",
				actor: who.actor,
				actor_email: who.actorEmail,
				reason: who.reason,
				period,
			})
			.execute();
	});
}

/**
 * A user's current-period balance plus their lifetime credits consumed — the
 * shape the user-facing usage endpoint and the admin dashboard render.
 */
export interface CreditSummary {
	period: string;
	allowance: number;
	consumed: number;
	bonus: number;
	/** Spendable now: `allowance + bonus − consumed`. */
	balance: number;
	lifetimeConsumed: number;
}

/**
 * Read a user's current balance and lifetime credits consumed. A user with
 * no current-period row reads as a fresh full allowance — the same
 * absent-row = full-balance rule the gate uses.
 */
export async function getCreditSummary(userId: string): Promise<CreditSummary> {
	const period = getCurrentPeriod();
	const db = await getAppDb();
	const rows = await db
		.selectFrom("credit_months")
		.select(["period", "allowance", "consumed", "bonus"])
		.where("user_id", "=", userId)
		.execute();
	let lifetimeConsumed = 0;
	let current:
		| { allowance: number; consumed: number; bonus: number }
		| undefined;
	for (const row of rows) {
		lifetimeConsumed += row.consumed;
		if (row.period === period) current = row;
	}
	const allowance = current?.allowance ?? MONTHLY_CREDIT_ALLOWANCE;
	const consumed = current?.consumed ?? 0;
	const bonus = current?.bonus ?? 0;
	return {
		period,
		allowance,
		consumed,
		bonus,
		balance: allowance + bonus - consumed,
		lifetimeConsumed,
	};
}

/**
 * Read ONLY the current period's spendable balance — the hot-path read the
 * chat gate runs on every chargeable POST (one primary-key row, not the
 * O(months) summary scan the dashboards use).
 */
export async function getCurrentCreditBalance(userId: string): Promise<number> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("credit_months")
		.select(["allowance", "consumed", "bonus", "updated_at"])
		.where("user_id", "=", userId)
		.where("period", "=", getCurrentPeriod())
		.executeTakeFirst();
	return creditBalance(row);
}

/** The audit rows for the admin credit panel, newest first. */
export async function listCreditGrants(
	userId: string,
): Promise<CreditGrantDoc[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("credit_grants")
		.select([
			"amount",
			"type",
			"actor",
			"actor_email",
			"reason",
			"period",
			"created_at",
		])
		.where("user_id", "=", userId)
		.orderBy("created_at", "desc")
		.execute();
	return rows as CreditGrantDoc[];
}
