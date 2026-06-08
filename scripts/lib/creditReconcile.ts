/**
 * Pure reconciliation between the actual-cost usage ledger and the
 * authoritative run-ledger — the shared core of the read-only migration
 * scan AND the later dry-run migrator.
 *
 * ## What this answers
 *
 * The usage docs (`usage/{user}/months/{period}.cost_estimate`) historically
 * UNDER-count actual spend versus the per-run summaries
 * (`apps/{appId}/runs/{runId}.costEstimate`). The migration re-baselines usage
 * cost from the run-ledger, which is the truer source. This function computes,
 * per `(owner, period)` cell, the delta the re-baseline would write — plus the
 * three per-cell hazards a blind overwrite would otherwise hide.
 *
 * ## Why this file is dependency-free
 *
 * It imports NOTHING from Firestore, the `db` client, or `@/lib/db` — not even
 * the `$50` backstop constant (the threshold arrives as the `backstopUsd`
 * parameter). The reconciliation is a pure, total transformation over plain
 * data so it is exhaustively unit-testable without a Firestore stub, and so the
 * I/O wrapper (`inspect-credit-migration.ts`) and the future migrator can both
 * call it with their own reads. Keep it that way.
 *
 * ## Attribution model (and the three hazards it surfaces)
 *
 * Each run is attributed to its `finishedPeriod` — the month of `finishedAt` —
 * because that is exactly how the live writer stamps a thread's whole-thread
 * `costEstimate` (scalar-overwrite, last turn wins). Mirroring that here is
 * what makes the scan's per-cell sums comparable to the current usage docs.
 *
 * The mirror is faithful but lossy in three ways, each surfaced (never hidden):
 *
 * 1. **Cross-month threads.** A thread that starts in one month and finishes in
 *    the next attributes ALL its cost to the later month — over-attributing the
 *    later, under-attributing the earlier. Every such run is collected into the
 *    cell's `crossMonthRuns` for manual review before any write.
 * 2. **Soft-deleted apps.** Their runs survive and represent real cost the
 *    usage accumulator counted at the time, so they are INCLUDED in `ledgerSum`
 *    (matching usage semantics — there is no exclusion at write time). They are
 *    ALSO tallied into `softDeletedContribution` purely for transparency, so a
 *    reviewer can see how much of a cell's sum came from deleted apps.
 * 3. **Current-month backstop.** Re-baselining a CLOSED month is reporting-only
 *    and safe. But the CURRENT period feeds the live `$50` actual-cost backstop
 *    (`cost_estimate >= backstopUsd` → the gate 429s every POST), so a
 *    current-month re-baseline can re-block users a manual reset just unblocked.
 *    `overBackstopCurrentMonth` flags exactly those cells loudly.
 */

/** One run, flattened to just the fields the reconciliation reads. */
export interface RunInput {
	runId: string;
	appId: string;
	ownerId: string;
	/** The owning app's `deleted_at != null` — a soft-deleted app's runs still count. */
	deleted: boolean;
	costEstimate: number;
	/** "yyyy-mm" derived from the run's `startedAt`. */
	startedPeriod: string;
	/** "yyyy-mm" derived from the run's `finishedAt` — the attribution month. */
	finishedPeriod: string;
}

/** A run whose thread straddled a month boundary — needs manual review. */
export interface CrossMonthRun {
	runId: string;
	appId: string;
	startedPeriod: string;
	finishedPeriod: string;
	costEstimate: number;
}

/** The reconciliation result for one `(owner, period)` cell. */
export interface CellRow {
	ownerId: string;
	/** Attribution month — equals every contained run's `finishedPeriod`. */
	period: string;
	/** Current usage `cost_estimate` for this cell (0 when no usage doc exists). */
	current: number;
	/** Σ `costEstimate` of every run in this cell — INCLUDES soft-deleted runs. */
	ledgerSum: number;
	/** `ledgerSum − current` — what the re-baseline would shift this cell by. */
	delta: number;
	/** Whether this cell's period is the live current period (backstop-sensitive). */
	isCurrentMonth: boolean;
	/** Σ `costEstimate` of the cell's soft-deleted runs (a subset of `ledgerSum`). */
	softDeletedContribution: number;
	/** The cell's runs whose `startedPeriod !== finishedPeriod`. */
	crossMonthRuns: CrossMonthRun[];
	/** `isCurrentMonth && ledgerSum >= backstopUsd` — re-baselining trips the gate. */
	overBackstopCurrentMonth: boolean;
}

/** Cell-map key — the same `${ownerId}/${period}` shape the usage map uses. */
function cellKey(ownerId: string, period: string): string {
	return `${ownerId}/${period}`;
}

export function creditReconcile(
	runs: RunInput[],
	currentUsage: Map<string, number>,
	currentPeriod: string,
	backstopUsd: number,
): CellRow[] {
	/* Group runs by their attribution cell. A run lands in the cell for its
	 * `finishedPeriod` — that mirrors how the live writer stamps a thread's
	 * whole cost at the finished month, so the per-cell sums here line up with
	 * the usage docs they'll be compared against. */
	const cellRuns = new Map<string, RunInput[]>();
	for (const r of runs) {
		const key = cellKey(r.ownerId, r.finishedPeriod);
		const bucket = cellRuns.get(key);
		if (bucket) bucket.push(r);
		else cellRuns.set(key, [r]);
	}

	const rows: CellRow[] = [];
	for (const cellGroup of cellRuns.values()) {
		/* Every run in a group shares the same (ownerId, finishedPeriod) by
		 * construction, so the first run names the cell. */
		const { ownerId, finishedPeriod: period } = cellGroup[0];

		/* Three INDEPENDENT reductions over the same runs — a single run can be
		 * both soft-deleted and cross-month, so these are computed separately,
		 * never as mutually-exclusive branches:
		 *   - ledgerSum:  ALL runs (deleted included — they were real cost).
		 *   - softDeleted: the deleted subset, for transparency only.
		 *   - crossMonth:  runs whose thread straddled a month boundary. */
		let ledgerSum = 0;
		let softDeletedContribution = 0;
		const crossMonthRuns: CrossMonthRun[] = [];
		for (const r of cellGroup) {
			ledgerSum += r.costEstimate;
			if (r.deleted) softDeletedContribution += r.costEstimate;
			if (r.startedPeriod !== r.finishedPeriod) {
				crossMonthRuns.push({
					runId: r.runId,
					appId: r.appId,
					startedPeriod: r.startedPeriod,
					finishedPeriod: r.finishedPeriod,
					costEstimate: r.costEstimate,
				});
			}
		}

		/* Current usage cost for this cell; an absent doc reads as $0 (the cell
		 * exists in the ledger but the usage doc never recorded it). */
		const current = currentUsage.get(cellKey(ownerId, period)) ?? 0;

		/* The current period is the only backstop-sensitive month: only its
		 * usage `cost_estimate` feeds the live $50 gate, so a re-baseline that
		 * pushes it to/over the backstop would re-block the user on every POST. */
		const isCurrentMonth = period === currentPeriod;

		rows.push({
			ownerId,
			period,
			current,
			ledgerSum,
			delta: ledgerSum - current,
			isCurrentMonth,
			softDeletedContribution,
			crossMonthRuns,
			overBackstopCurrentMonth: isCurrentMonth && ledgerSum >= backstopUsd,
		});
	}

	/* Deterministic order (ownerId, then period) so the scan's PROD output is
	 * stable run-to-run and diffable. */
	rows.sort((a, b) =>
		a.ownerId === b.ownerId
			? a.period.localeCompare(b.period)
			: a.ownerId.localeCompare(b.ownerId),
	);
	return rows;
}

// ── Re-baseline planning (the migrator's pure decision core) ─────────

/**
 * Half the last-displayed (4-dp) digit. A cell whose TRUE delta is zero can
 * still carry float-addition noise (`ledgerSum` and `current` are the same
 * multiset summed in different orders, and float `+` is non-associative), so a
 * `!== 0` test would plan a misleading `+$0.0000` write. Below this magnitude a
 * cell is treated as already-baselined — no write planned.
 *
 * Exported so the scan's "would move" preview filter and the migrator's planner
 * share ONE cut — the preview can never list a cell the apply skips, or vice
 * versa.
 */
export const MATERIAL_DELTA_USD = 0.00005;

/** One planned re-baseline write: overwrite this cell's `cost_estimate`. */
export interface RebaselineWrite {
	ownerId: string;
	period: string;
	/** The cell's current usage `cost_estimate` (what the write replaces). */
	from: number;
	/** The authoritative ledger sum (what the write sets `cost_estimate` to). */
	to: number;
}

/**
 * The migrator's full re-baseline plan, partitioned by the decisive safety rule.
 *
 * Re-baselining a CLOSED month is reporting-only and safe, so every closed-month
 * write applies automatically. The CURRENT month's `cost_estimate` feeds the
 * live actual-cost backstop (`cost_estimate >= backstop` → the chat gate 429s
 * every POST), so a current-month re-baseline can re-block a user a manual reset
 * just unblocked. Current-month writes therefore apply ONLY for explicitly
 * opted-in owners; the rest are surfaced as `currentSkipped` (never silently
 * written), with `overBackstop` marked loudly so the operator sees exactly which
 * skips would have re-blocked.
 */
export interface RebaselinePlan {
	/** Closed-month writes — always applied (reporting-only, safe). */
	closedWrites: RebaselineWrite[];
	/** Current-month writes for opted-in owners — applied. */
	currentWrites: RebaselineWrite[];
	/** Current-month cells NOT opted in — surfaced, never written. */
	currentSkipped: (RebaselineWrite & {
		/** Whether applying this write would trip the live backstop (re-block). */
		overBackstop: boolean;
	})[];
}

/**
 * Partition reconciled cells into the writes the migrator may apply versus the
 * current-month cells it must hold back.
 *
 * Pure and total: it reads the explicit `isCurrentMonth` / `overBackstopCurrentMonth`
 * flags the reconciliation already computed (no clock here) and the explicit
 * opt-in set (no Firestore here). A cell with no material delta produces nothing.
 *
 * `currentUserEmails` is matched against `emailOf.get(ownerId)` — the opt-in is
 * expressed by EMAIL (operator-facing) but routed by `ownerId` (the doc key).
 * `emailOf` holds ONLY owners with a real email, so an owner with no resolvable
 * email (missing `auth_users` doc, or present but email-less) is simply absent:
 * `emailOf.get(ownerId)` is `undefined` and folds to the empty string. The match
 * then explicitly refuses the empty string (rather than relying on it being
 * absent from the set — a stray "" from an unset `--current-user "$VAR"` would
 * otherwise opt in every unresolvable owner at once). This fails safe: no
 * current-month write for an owner whose email can't be resolved.
 *
 * Email matching is case/whitespace-insensitive: `currentUserEmails` is expected
 * pre-normalized (trimmed + lowercased) by the caller, and the resolved email is
 * normalized the same way HERE before the lookup. Normalizing only one side
 * would drop an exact-but-mixed-case opt-in (stored `Alice@X.com`, typed
 * `alice@x.com`) into the skipped bucket — silently failing a correct opt-in at
 * the live apply. Only this comparison key is folded; the operator-facing display
 * label (with its `?? ownerId` fallback) is the caller's concern at the print site.
 */
export function planRebaseline(
	rows: CellRow[],
	currentUserEmails: Set<string>,
	emailOf: Map<string, string>,
): RebaselinePlan {
	const plan: RebaselinePlan = {
		closedWrites: [],
		currentWrites: [],
		currentSkipped: [],
	};

	for (const row of rows) {
		/* Only cells whose cost would actually move are written — a sub-cent
		 * float-noise delta is not a real re-baseline. */
		if (Math.abs(row.delta) < MATERIAL_DELTA_USD) continue;

		const write: RebaselineWrite = {
			ownerId: row.ownerId,
			period: row.period,
			from: row.current,
			to: row.ledgerSum,
		};

		/* Closed months are reporting-only — always safe to re-baseline. */
		if (!row.isCurrentMonth) {
			plan.closedWrites.push(write);
			continue;
		}

		/* Current month: write only when the owner is explicitly opted in;
		 * otherwise surface (never silently write) with the backstop marker so
		 * the operator can see which holds would have re-blocked the user. The
		 * resolved email is folded (trim + lowercase) to match the pre-normalized
		 * opt-in set. The `resolvedEmail !== ""` guard is the fail-safe the JSDoc
		 * promises: an owner with no resolvable email folds to "", and were a
		 * stray "" ever in the opt-in set (e.g. an unset `--current-user "$VAR"`),
		 * `has("")` would be true and silently opt in EVERY unresolved-email cell.
		 * Refusing "" here means an unresolved owner can never be opted in,
		 * regardless of the set's contents. */
		const resolvedEmail = (emailOf.get(row.ownerId) ?? "").trim().toLowerCase();
		const optedIn =
			resolvedEmail !== "" && currentUserEmails.has(resolvedEmail);
		if (optedIn) {
			plan.currentWrites.push(write);
		} else {
			plan.currentSkipped.push({
				...write,
				overBackstop: row.overBackstopCurrentMonth,
			});
		}
	}

	return plan;
}
