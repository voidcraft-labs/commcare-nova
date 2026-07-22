import { type RawBuilder, sql } from "kysely";
import type { RunHolderIdentity } from "./runLiveness";

/** A caller-supplied holder token. Corrupt persisted holders keep `runId: null`
 * in the database model, but an operator or terminal writer can prove only a
 * concrete, non-empty run id. */
export interface ExactRunHolderIdentity {
	readonly mode: "build" | "edit";
	readonly runId: string;
}

/** Narrow a database-derived holder identity to the token shape callers may
 * assert. Empty and missing ids remain unprovable rather than becoming a
 * wildcard. */
export function toExactRunHolderIdentity(
	identity: RunHolderIdentity | null,
): ExactRunHolderIdentity | null {
	return identity !== null &&
		identity.runId !== null &&
		identity.runId.length > 0
		? { mode: identity.mode, runId: identity.runId }
		: null;
}

/** Exact mode-and-run equality. A nullable/corrupt holder never matches a
 * caller token. */
export function exactRunHolderMatches(
	actual: RunHolderIdentity | null,
	expected: ExactRunHolderIdentity,
): boolean {
	return (
		typeof expected.runId === "string" &&
		expected.runId.length > 0 &&
		actual?.mode === expected.mode &&
		actual.runId === expected.runId
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
): RawBuilder<boolean> {
	if (expected.mode === "build") {
		return sql<boolean>`
			${sql.ref("status")} = 'generating'
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
		AND ${sql.ref("lock_run_id")} IS NOT NULL
		AND NULLIF(${sql.ref("lock_run_id")}, '') = ${expected.runId}
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
	runId: string,
): RawBuilder<boolean> {
	return sql<boolean>`
		${noRunHolderPredicate()}
		AND ${sql.ref("status")} = 'error'
		AND NULLIF(${sql.ref("run_id")}, '') = ${runId}
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
	return result.numUpdatedRows === 1n;
}
