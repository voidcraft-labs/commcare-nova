import { type RawBuilder, sql } from "kysely";
import type { RunHolderIdentity } from "./runLiveness";

/** A concrete-run holder token carried by runtime writers and reaper scans.
 * Persisted holders with `runId: null` are corrupt/unprovable. `nonce: null` is
 * reserved for observed legacy v0 holders and is admissible only while the
 * compatibility switch still projects authority to mode + run id. */
export interface ExactRunHolderIdentity {
	readonly mode: "build" | "edit";
	readonly runId: string;
	/** Null only for a v0 holder observed before nonce enforcement. */
	readonly nonce: string | null;
}

/** Result of an exact-holder terminal compare-and-set. */
export type RunHolderWriteOutcome = "owned" | "superseded" | "released";

/** Narrow a database-derived holder identity to the token shape callers may
 * assert. Empty and missing ids remain unprovable rather than becoming a
 * wildcard. */
export function toExactRunHolderIdentity(
	identity: RunHolderIdentity | null,
): ExactRunHolderIdentity | null {
	return identity !== null &&
		identity.runId !== null &&
		identity.runId.length > 0 &&
		(identity.nonce === null || identity.nonce.length > 0)
		? { mode: identity.mode, runId: identity.runId, nonce: identity.nonce }
		: null;
}

/** Compatibility-aware holder equality. Mode + run id are always required;
 * nonce joins the proof only after the irreversible enforcement switch. */
export function exactRunHolderMatches(
	actual: RunHolderIdentity | null,
	expected: ExactRunHolderIdentity,
	enforceNonce: boolean,
): boolean {
	return (
		typeof expected.runId === "string" &&
		expected.runId.length > 0 &&
		actual?.mode === expected.mode &&
		actual.runId === expected.runId &&
		(!enforceNonce ||
			(typeof expected.nonce === "string" &&
				expected.nonce.length > 0 &&
				actual.nonce === expected.nonce))
	);
}

/**
 * SQL compare-and-set predicate for the database-owned holder identity.
 *
 * Build identity follows the holder trigger exactly: `run_id` only before a
 * reservation exists, then `res_run_id`. Edit identity is `lock_run_id`, and a
 * generating row is always a build even if a stale lock remains. Only a
 * concrete run id is admissible: `(mode, null)` is corrupt state, not a token,
 * and cannot distinguish one corrupt generation from a later one.
 */
export function expectedRunHolderPredicate(
	expected: ExactRunHolderIdentity,
	enforceNonce: boolean,
): RawBuilder<boolean> {
	const noncePredicate = !enforceNonce
		? sql<boolean>`TRUE`
		: expected.nonce === null
			? sql<boolean>`FALSE`
			: sql<boolean>`
				${sql.ref("run_holder_nonce")} = ${expected.nonce}
			`;
	if (expected.mode === "build") {
		return sql<boolean>`
			${sql.ref("status")} = 'generating'
			AND ${noncePredicate}
			AND (
				(
					${sql.ref("res_period")} IS NULL
					AND NULLIF(${sql.ref("run_id")}, '') = ${expected.runId}
				)
				OR (
					${sql.ref("res_period")} IS NOT NULL
					AND NULLIF(${sql.ref("res_run_id")}, '') = ${expected.runId}
				)
			)
		`;
	}
	return sql<boolean>`
		${sql.ref("status")} <> 'generating'
		AND ${noncePredicate}
		AND ${sql.ref("lock_run_id")} IS NOT NULL
		AND NULLIF(${sql.ref("lock_run_id")}, '') = ${expected.runId}
	`;
}

/**
 * Final compare-and-set for a free continuation. Holder equality alone is not
 * enough: the row must still be paused and must still name the authenticated
 * actor who owns that pause. Build actor identity normally comes from the
 * reservation marker; migrated legacy markers without `res_user_id` retain
 * the owner fallback used by the liveness reader.
 */
export function expectedPausedRunResumePredicate(
	expected: ExactRunHolderIdentity,
	actorUserId: string,
	enforceNonce: boolean,
): RawBuilder<boolean> {
	const actorPredicate =
		expected.mode === "build"
			? sql<boolean>`
				(
					${sql.ref("res_user_id")} = ${actorUserId}
					OR (
						${sql.ref("res_user_id")} IS NULL
						AND ${sql.ref("owner")} = ${actorUserId}
					)
				)
			`
			: sql<boolean>`${sql.ref("lock_actor_user_id")} = ${actorUserId}`;
	return sql<boolean>`
		(${expectedRunHolderPredicate(expected, enforceNonce)})
		AND ${sql.ref("awaiting_input")} IS TRUE
		AND (${actorPredicate})
	`;
}

/** Exact free-app predicate used by operator recovery. It prevents a holder
 * that appears before the conditional write from being released tokenlessly. */
export function noRunHolderPredicate(): RawBuilder<boolean> {
	return sql<boolean>`
		${sql.ref("status")} <> 'generating'
		AND ${sql.ref("lock_run_id")} IS NULL
	`;
}

/** The only absent-holder terminal exception: a falsely reaped build may
 * repair its own error row if the exact marker-cleared reaper signature and
 * latest build claim/writer still name that build. A pre-settled stale marker
 * retains `res_run_id` and cannot match; any replacement holder or claim changes
 * the root identity and makes this predicate false. */
export function expectedReapedBuildCompletionPredicate(
	expected: ExactRunHolderIdentity,
	enforceNonce: boolean,
): RawBuilder<boolean> {
	const noncePredicate = !enforceNonce
		? sql<boolean>`TRUE`
		: expected.nonce === null
			? sql<boolean>`FALSE`
			: sql<boolean>`${sql.ref("run_holder_nonce")} = ${expected.nonce}`;
	return sql<boolean>`
		${noRunHolderPredicate()}
		AND ${sql.ref("status")} = 'error'
		AND NULLIF(${sql.ref("run_id")}, '') = ${expected.runId}
		AND ${noncePredicate}
		AND ${sql.ref("res_period")} IS NOT NULL
		AND ${sql.ref("res_settled")} IS TRUE
		AND ${sql.ref("res_run_id")} IS NULL
	`;
}

/** Kysely reports affected rows as bigint on Postgres. Keep the exact-one
 * check shared so conditional lifecycle writers cannot silently treat a
 * zero-row compare-and-set as success. */
export function updatedExactlyOne(result: {
	readonly numUpdatedRows: bigint;
}): boolean {
	return result.numUpdatedRows === BigInt(1);
}
