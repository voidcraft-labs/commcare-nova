/**
 * Materialize the case-store schema rows + per-property indexes
 * for every case type a chat run's blueprint carries.
 *
 * ## What this closes
 *
 * The SA's chat-side commit writes Firestore only (each tool batch
 * commits inline through `commitGuardedBatch`, which does not run the
 * Postgres schema saga), so `case_type_schemas` carries no row for
 * any case type the SA just generated. Until the user's first
 * awaited write (auto-save PUT or MCP tool call) routes through
 * `applyBlueprintChange` and lands the schema sync, every
 * case-store insert path fires `SchemaNotSyncedError`:
 *
 *   - `populateSampleCasesAction` (sample-data populate).
 *   - `submitFormAction` (form submit).
 *   - Live-preview panels that mount a `PostgresCaseStore` query.
 *
 * The chat route's drain-end finalize calls this for the run's
 * final persisted doc (builds AND edits), BEFORE the build arm's
 * status flip and `data-done` SSE emit. The ordering matters:
 *
 *   1. Await this helper — UPSERTs the schema row + indexes for
 *      every case type. Blocks until Postgres is caught up.
 *   2. `completeApp` — the awaited status-only flip (builds).
 *   3. `data-done` SSE emit — the UX signal that the build is
 *      done; the client's stream dispatcher stamps `runCompletedAt`
 *      on this event, which drives the Completed celebration phase.
 *
 * Materializing BEFORE `data-done` is load-bearing. The
 * case-store consumers (`populateSampleCasesAction`,
 * `submitFormAction`, live-preview panels) don't gate on
 * `app.status === "complete"` before issuing reads / writes;
 * they call `withProjectContext` and dispatch directly. If
 * `data-done` fired first, a user clicking "Generate sample
 * data" sub-second after the celebration animation would race
 * the materialization and trip `SchemaNotSyncedError`.
 * Sequencing the await before the SSE emit means any
 * user-initiated case-store action subsequent to the completion
 * celebration sees a synced schema. (On MCP, the cross-store saga
 * inside every guarded commit covers the same contract — a
 * case-type-touching batch syncs its schema before the tool
 * returns.)
 *
 * ## Why no saga
 *
 * Idempotent UPSERT over whatever the blueprint carries — there is
 * no per-row migration here and nothing to compensate on failure.
 * The compensation surface `applyBlueprintChange.ts` builds for
 * awaited writes is irrelevant here.
 *
 * ## Failure handling
 *
 * Each per-case-type sync retries only TRANSIENT failures, up to
 * `PER_TYPE_SYNC_ATTEMPTS` (see `isTransientDbError`) — the canonical
 * drain-end failure is a transient Postgres blip, and the
 * `applySchemaChange` UPSERT + index diff is idempotent, so retrying
 * turns most blips into a successful sync rather than a missing/stale
 * row the point-of-use heal then has to repair. A DETERMINISTIC fault
 * (e.g. an identifier collision) is NOT retried — it would fail
 * identically, so it stops the loop at the offending case type and
 * bubbles unwrapped on the first attempt. The chat route's build arm
 * routes that throw through `failRun` (classify + emit + refund +
 * `failApp`) so the client sees the error and no celebration fires over
 * an unsynced store; the edit arm logs it (the edit itself succeeded).
 *
 * The retry SHRINKS the producer of inconsistent rows; the gap that
 * survives it still closes at the point of use — every case-store
 * consumer (sample-populate, form submit, live preview) re-runs this
 * helper from the persisted blueprint and retries once (`withSchemaHeal`
 * in `lib/preview/engine/caseDataBindingHelpers.ts`). The heal recovers
 * BOTH shapes the swallow can leave behind: a MISSING row
 * (`SchemaNotSyncedError`, when no prior sync ever landed) AND a STALE
 * row whose schema rejected a NEWLY-added property
 * (`CasePropertiesValidationError` with an `additionalProperty` failure
 * — a write carrying the new property trips `additionalProperties`
 * against the older-catalog row). Both heal by re-running this helper
 * over the WHOLE blueprint, so one heal repairs every type a partial
 * materialize-failure left behind (a multi-type write recovers in one
 * pass). Swallowing failures here would relocate that gap this helper
 * exists to close, not widen it.
 */

import { buildCaseTypeMap, withSchemaContext } from "@/lib/case-store";
import type { PersistableDoc } from "@/lib/domain";
import { delay } from "@/lib/utils/delay";

/**
 * Arguments for `materializeCaseStoreSchemas`. The blueprint is
 * the run's final persisted snapshot; it carries the canonical
 * `caseTypes` list the helper iterates. The route passes the same
 * snapshot into the subsequent `data-done` SSE emit so the
 * client's reconciliation matches what Postgres just landed.
 */
export interface MaterializeCaseStoreSchemasArgs {
	readonly appId: string;
	readonly blueprint: PersistableDoc;
}

/**
 * Bounded retry budget for one per-case-type sync, applied ONLY to
 * transient failures (see `isTransientDbError`). The drain-end
 * materialize's canonical failure is a transient Postgres blip; the
 * underlying `applySchemaChange` is an idempotent UPSERT + index diff,
 * so retrying turns most blips into a successful sync. A deterministic
 * fault is NOT retried — it would fail identically every time, so
 * burning the backoff budget on it only delays the inevitable bubble.
 */
const PER_TYPE_SYNC_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 150;

/**
 * Error codes that mark a TRANSIENT Postgres / connection failure worth
 * retrying. Postgres query errors carry a SQLSTATE on `error.code`;
 * connector / socket failures carry a Node errno string. A deterministic
 * application fault (e.g. the identifier-collision throw at
 * `applySchemaChange`'s pre-flight) is a plain `Error` with no `code`, so
 * it falls through as non-transient and bubbles on the first attempt.
 *
 * Conservative by design: a transient error we fail to recognize simply
 * isn't retried (the point-of-use heal is still the backstop), whereas
 * retrying a deterministic fault wastes the whole backoff budget on the
 * build-arm critical path. So we only widen this set for codes we know
 * are transient.
 */
const TRANSIENT_DB_ERROR_CODES: ReadonlySet<string> = new Set([
	// Node socket errnos — connector / network blips.
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"EPIPE",
	"ENOTFOUND",
	"EAI_AGAIN",
	// SQLSTATE class 08 — connection exception.
	"08000",
	"08001",
	"08003",
	"08004",
	"08006",
	"08007",
	"08P01",
	// 57Pxx — server shutting down / not yet accepting connections.
	"57P01",
	"57P02",
	"57P03",
	// Concurrency faults — safe to retry an idempotent UPSERT.
	"40001",
	"40P01",
]);

/**
 * Whether `error` (or its wrapped `cause`) is a transient Postgres /
 * connection fault worth retrying. The pg driver / Cloud SQL connector
 * surface the SQLSTATE or socket errno on `.code`; a wrapped blip carries
 * it on `.cause.code` one level down. We unwrap a single level — deeper
 * nesting is rare and the point-of-use heal is the backstop regardless.
 */
function isTransientDbError(error: unknown): boolean {
	const layers = [
		error,
		(error as { cause?: unknown } | null | undefined)?.cause,
	];
	for (const layer of layers) {
		const code = (layer as { code?: unknown } | null | undefined)?.code;
		if (typeof code === "string" && TRANSIENT_DB_ERROR_CODES.has(code)) {
			return true;
		}
	}
	return false;
}

/**
 * Run `attempt`, retrying only TRANSIENT failures up to
 * `PER_TYPE_SYNC_ATTEMPTS`. A non-transient (deterministic) error bubbles
 * immediately on the first attempt — no wasted backoff — so the build arm
 * reaches `failRun` and the edit arm reaches its log without delay. Linear
 * backoff bounds the worst-case added latency for a genuinely transient
 * fault.
 */
async function withTransientRetry(
	attempt: () => Promise<unknown>,
): Promise<void> {
	for (let i = 1; i <= PER_TYPE_SYNC_ATTEMPTS; i++) {
		try {
			await attempt();
			return;
		} catch (error) {
			if (i >= PER_TYPE_SYNC_ATTEMPTS || !isTransientDbError(error)) {
				throw error;
			}
			await delay(RETRY_BACKOFF_MS * i);
		}
	}
}

/**
 * For every case type in `blueprint.caseTypes`, call `applySchemaChange`
 * with no `property` / `change` — the additive arm that UPSERTs
 * `case_type_schemas` and emits the matching `CREATE INDEX CONCURRENTLY`
 * statements for any per-property indexes the case-type's `data_type` set
 * declares. Each per-type sync runs under `withTransientRetry` so a
 * transient Postgres blip doesn't leave the row missing/stale.
 *
 * Always whole-blueprint: callers that need a single case type (the
 * point-of-use heal) accept the redundant idempotent UPSERTs for the
 * already-synced types because they fire only on a rare genuine
 * missing/drift event, and syncing every type is what makes a multi-type
 * write (a registration creating children of several case types) recover
 * in one pass rather than one heal per stale type.
 *
 * No-op when `caseTypes` is null (survey-only build) or empty. The early
 * return skips the `withSchemaContext` allocation so a survey-only
 * completion never pays the connection-pool lookup cost.
 */
export async function materializeCaseStoreSchemas(
	args: MaterializeCaseStoreSchemasArgs,
): Promise<void> {
	const caseTypes = args.blueprint.caseTypes;
	if (caseTypes === null || caseTypes.length === 0) {
		return;
	}

	// `withSchemaContext` returns a tenant-FREE `SchemaCaseStore`:
	// `applySchemaChange` is app-scoped (it syncs the schema row + the
	// per-property indexes + migrates EVERY member's rows of the case
	// type), so it needs no bound Project. This helper never reads or
	// writes a single tenant's case data, so it binds none.
	const store = await withSchemaContext();

	// Sequential rather than parallel: each `applySchemaChange`
	// touches Postgres index DDL via `CREATE INDEX CONCURRENTLY`,
	// which doesn't lock writes but does serialize against
	// other catalog mutations per relation. Parallel calls would
	// only help if case types touched disjoint relations, but
	// every case type writes against the same `cases` heap.
	// Sequential keeps the semantics simple and the failure
	// reporting deterministic — a (retry-exhausted) throw on case
	// type N stops the loop at N, the operator sees exactly which
	// case type failed.
	// `applySchemaChange` accepts the case-type schema map every
	// compiler in the case-store stack reads from; the boundary
	// builds it once from the persisted blueprint. `buildCaseTypeMap`
	// reads `caseTypes` only, so the `PersistableDoc` goes through
	// directly — no cast to the in-memory `BlueprintDoc` shape.
	const caseTypeSchemas = buildCaseTypeMap(args.blueprint);
	for (const caseType of caseTypes) {
		await withTransientRetry(() =>
			store.applySchemaChange({
				appId: args.appId,
				caseType: caseType.name,
				caseTypeSchemas,
			}),
		);
	}
}
