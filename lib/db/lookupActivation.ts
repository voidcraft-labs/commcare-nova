/**
 * Activation-flag reads over the `lookup_reference_compatibility`
 * singleton, split out of `rolloutCompatibility.ts` (the operational
 * compatibility service) with deliberately NO `server-only` marker:
 * the tsx-run smoke seeds and inspect scripts import `apps.ts` /
 * `appAccess.ts`, whose commit-path admission reads land here — the
 * same trade `threads.ts` documents. The operational service (floor
 * raises, emergency disablement, cutover machinery) keeps its marker
 * and re-exports the shared error class from here.
 */

import type { Transaction } from "kysely";
import type { LookupActivationState } from "@/lib/doc/lookupReferences";
import { type AppDatabase, getAppDb } from "./pg";

export type RolloutCompatibilityErrorCode =
	| "compatibility_state_missing"
	| "invalid_version"
	| "receiving_revisions_required"
	| "receiving_revision_incompatible"
	| "floor_cannot_decrease"
	| "runtime_epoch_missing"
	| "runtime_epoch_too_young"
	| "runtime_holders_not_drained";

export class RolloutCompatibilityError extends Error {
	readonly code: RolloutCompatibilityErrorCode;
	readonly details?: Readonly<Record<string, unknown>>;

	constructor(
		code: RolloutCompatibilityErrorCode,
		message: string,
		details?: Readonly<Record<string, unknown>>,
	) {
		super(message);
		this.name = "RolloutCompatibilityError";
		this.code = code;
		this.details = details;
	}
}

/**
 * The dormant-vocabulary activation flags, read `FOR SHARE` inside an
 * authoritative commit transaction — the in-transaction admission the
 * commit gate's verdict re-run conditions on. Same lock shape as the
 * writer guard's own singleton read, so no new lock edge. Call after
 * locking the target app row.
 */
export async function readLookupActivationForShare(
	tx: Transaction<AppDatabase>,
): Promise<LookupActivationState> {
	const row = await tx
		.selectFrom("lookup_reference_compatibility")
		.select(["carrier_commits_enabled", "case_operations_enabled"])
		.where("id", "=", 1)
		.forShare()
		.executeTakeFirst();
	if (!row) {
		throw new RolloutCompatibilityError(
			"compatibility_state_missing",
			"Lookup-reference compatibility state is missing.",
		);
	}
	return {
		carrierCommitsEnabled: row.carrier_commits_enabled,
		caseOperationsEnabled: row.case_operations_enabled,
	};
}

/**
 * Plain snapshot of the activation flags for non-transactional
 * consumers: the app access payload's client projection and the
 * export boundary's zero-tolerance run. Advisory on the client (the
 * in-transaction read above wins); authoritative enough for the
 * boundary, whose callers hold no app lock.
 */
export async function readLookupActivationFlags(): Promise<LookupActivationState> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("lookup_reference_compatibility")
		.select(["carrier_commits_enabled", "case_operations_enabled"])
		.where("id", "=", 1)
		.executeTakeFirst();
	if (!row) {
		throw new RolloutCompatibilityError(
			"compatibility_state_missing",
			"Lookup-reference compatibility state is missing.",
		);
	}
	return {
		carrierCommitsEnabled: row.carrier_commits_enabled,
		caseOperationsEnabled: row.case_operations_enabled,
	};
}
