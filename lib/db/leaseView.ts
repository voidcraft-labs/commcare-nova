// The sanctioned row→view mapping for run-liveness decisions — the ONE place
// the raw `res_*` / `lock_*` columns become the `AppReservation` / `AppRunLock`
// objects `runLeaseState` consumes. Both credit-deciding modules (`apps.ts`,
// `credits.ts`) import from here rather than each mapping the columns
// themselves; the grep guard (`runLivenessGrepGuard.test.ts`) blanks exactly
// these three function bodies and then fails on any OTHER member-read of the
// pure liveness columns, so a new decision path physically cannot read them
// raw.

import type { AppDoc, AppReservation, AppRunLock } from "./types";

/** The run-liveness slice of an `apps` row — the column list every
 *  liveness-deciding SELECT uses, so no site can under-select and hand
 *  `leaseView` a partial row. */
export const LEASE_COLUMNS = [
	"status",
	"awaiting_input",
	"updated_at",
	"owner",
	"run_id",
	"res_period",
	"res_reserved",
	"res_settled",
	"res_user_id",
	"res_run_id",
	"lock_run_id",
	"lock_actor_user_id",
	"lock_expire_at",
] as const;

/** The selected shape of {@link LEASE_COLUMNS}. Wider rows (a full
 *  `Selectable<AppsTable>`) are structurally assignable. */
export interface LeaseRow {
	status: string;
	awaiting_input: boolean;
	updated_at: Date;
	owner: string;
	run_id: string | null;
	res_period: string | null;
	res_reserved: number | null;
	res_settled: boolean | null;
	res_user_id: string | null;
	res_run_id: string | null;
	lock_run_id: string | null;
	lock_actor_user_id: string | null;
	lock_expire_at: Date | null;
}

/** The reservation marker — present iff `res_period` is set. */
export function rowReservation(row: LeaseRow): AppReservation | undefined {
	if (row.res_period === null) return undefined;
	return {
		period: row.res_period,
		reserved: row.res_reserved ?? 0,
		settled: !!row.res_settled,
		...(row.res_user_id !== null && { userId: row.res_user_id }),
		...(row.res_run_id !== null && { runId: row.res_run_id }),
	};
}

/** The edit-run lease — present iff `lock_run_id` is set. A set lock with a
 *  null deadline maps to epoch 0, which the liveness reader treats as
 *  expired (the safe reading of a corrupt lock). */
export function rowRunLock(row: LeaseRow): AppRunLock | undefined {
	if (row.lock_run_id === null) return undefined;
	return {
		runId: row.lock_run_id,
		actorUserId: row.lock_actor_user_id ?? "",
		expireAt: row.lock_expire_at ?? new Date(0),
	};
}

/** The run-liveness slice `runLeaseState` reads, off a raw row. */
export function leaseView(row: LeaseRow): Partial<AppDoc> {
	return {
		status: row.status as AppDoc["status"],
		awaiting_input: row.awaiting_input,
		updated_at: row.updated_at,
		owner: row.owner,
		run_id: row.run_id,
		reservation: rowReservation(row),
		run_lock: rowRunLock(row),
	};
}
