/**
 * Materialize the case-store schema rows + per-property indexes
 * for every case type a chat run's blueprint carries.
 *
 * ## What this closes
 *
 * The SA's chat-side commit writes the blueprint only (each tool batch
 * commits inline through `commitGuardedBatch`, which does not run the
 * case-store schema saga), so `case_type_schemas` carries no row for
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
 *   2. `completeAndSettleRun` (atomic status-flip + kept-charge settle, builds).
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
 * ## The `syncedSeq` guard
 *
 * The materialize passes `syncedSeq` — the `mutation_seq` of the
 * EXACT blueprint it materializes — through to `applySchemaChange`,
 * where the monotone `synced_seq` gate makes it converge with any
 * concurrent additive sync: a stale lower-seq materialize no-ops
 * against a fresher row, and a peer's concurrently-committed
 * property survives. The seq comes from `ctx.latestCommittedSeq()`
 * (the chat drain-end) or `app.mutation_seq` off the SAME snapshot
 * as the blueprint (the point-of-use heal) — never a fresh
 * `loadApp().mutation_seq`, which could pair a later seq with an
 * earlier blueprint and defeat the guard.
 *
 * ## Why no saga
 *
 * Idempotent UPSERT over whatever the blueprint carries — this
 * boundary passes no `change`, so no caller-intent migration runs,
 * and nothing needs compensating on failure (the store's own
 * string↔array reshape may still rewrite rows inside the sync,
 * atomically with the schema write — see `applySchemaChange`). The
 * compensation surface `applyBlueprintChange.ts` builds for awaited
 * writes is irrelevant here.
 *
 * ## Failure handling — retry transient, swallow transient, THROW deterministic
 *
 * Each per-case-type sync retries a TRANSIENT Postgres blip
 * (`withTransientRetry` — the canonical drain-end failure, and
 * `applySchemaChange` is an idempotent UPSERT so the retry usually lands the
 * sync). The terminal outcome then splits on fault class:
 *
 *   - **Transient** (retry exhausted — a sustained Cloud SQL outage): swallow
 *     + `warn`. A transiently-unsynced store is degraded-but-recoverable, so a
 *     chat run's finalize completes rather than routing through `failRun`; the
 *     point-of-use `withSchemaHeal` re-syncs on recovery.
 *   - **Deterministic** (no transient code — e.g. an identifier-collision
 *     `compilerBugMessage`, a `CaseTypeNotInBlueprintError`): RETHROW. A
 *     deterministic schema fault is a real bug that would fail identically on
 *     every heal, so a build must NOT complete-and-celebrate a charged,
 *     permanently-unusable app over it — the build finalize routes the throw
 *     through `failRun` (refund + classified error), matching the pre-P4
 *     contract. Only a genuinely-transient fault is hidden.
 *
 * The surviving transient gap closes at the point of use: every case-store
 * consumer (sample-populate, form submit, live preview) re-runs this helper
 * from the persisted blueprint (`withSchemaHeal` in
 * `lib/preview/engine/caseDataBindingHelpers.ts`). The heal recovers BOTH
 * shapes the swallow can leave behind: a MISSING row (`SchemaNotSyncedError`,
 * when no prior sync ever landed) AND a STALE row whose schema rejected a
 * NEWLY-added property (`CasePropertiesValidationError` with an
 * `additionalProperty` failure — a write carrying the new property trips
 * `additionalProperties` against the older-catalog row). Both heal by re-running
 * this helper over the WHOLE blueprint, so one heal repairs every type a partial
 * materialize-failure left behind (a multi-type write recovers in one pass). The
 * retry SHRINKS the window the heal has to cover so the heal's own first attempt
 * is less likely to hit the same blip.
 */

import { buildCaseTypeMap, withSchemaContext } from "@/lib/case-store";
import type { PersistableDoc } from "@/lib/domain";
import { log } from "@/lib/logger";
import { isTransientDbError, withTransientRetry } from "./schemaSyncRetry";

/**
 * Arguments for `materializeCaseStoreSchemas`. The blueprint is
 * the run's final persisted snapshot; it carries the canonical
 * `caseTypes` list the helper iterates. The route passes the same
 * snapshot into the subsequent `data-done` SSE emit so the
 * client's reconciliation matches what Postgres just landed.
 *
 * `syncedSeq` is the `mutation_seq` of THAT EXACT blueprint — the
 * chat drain-end reads `ctx.latestCommittedSeq()`, the point-of-use
 * heal reads `app.mutation_seq` off the same `loadApp` snapshot as
 * the blueprint. It feeds `applySchemaChange`'s monotone
 * `synced_seq` gate so a concurrent additive sync converges rather
 * than clobbers. Absent (a survey-only run committed no seq) means
 * the plain un-versioned additive UPSERT.
 */
export interface MaterializeCaseStoreSchemasArgs {
	readonly appId: string;
	readonly blueprint: PersistableDoc;
	readonly syncedSeq?: number;
}

/**
 * For every case type in `blueprint.caseTypes`, call `applySchemaChange`
 * with no `property` / `change` — the additive arm that UPSERTs
 * `case_type_schemas` (guarded by `syncedSeq`) and emits the matching
 * `CREATE INDEX CONCURRENTLY` statements for any per-property indexes the
 * case-type's `data_type` set declares.
 *
 * Always whole-blueprint: callers that need a single case type (the
 * point-of-use heal) accept the redundant idempotent UPSERTs for the
 * already-synced types because they fire only on a rare genuine
 * missing/drift event, and syncing every type is what makes a multi-type
 * write (a registration creating children of several case types) recover
 * in one pass rather than one heal per stale type.
 *
 * Throws only on a DETERMINISTIC fault — each per-type sync retries a transient
 * blip (`withTransientRetry`), then swallows a still-transient terminal throw
 * (`warn` + continue; the point-of-use `withSchemaHeal` is the backstop) but
 * RETHROWS a deterministic one (a real bug the build finalize must surface via
 * `failRun`, not celebrate over). Whole types can be left unsynced by a
 * sustained transient outage; each heals on its first case-store touch.
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
	// A transient blip is retried then swallowed; a DETERMINISTIC fault
	// rethrows (a real bug the build finalize surfaces via `failRun`).
	// `applySchemaChange` accepts a case-type schema map; the boundary
	// builds it once from the persisted blueprint, using the
	// MATERIALIZABLE flavor (derived property types included, implicit
	// standard entries excluded — see `buildCaseTypeMap`).
	// It reads `caseTypes` + `fields` only, so the `PersistableDoc`
	// goes through directly — no cast to the in-memory `BlueprintDoc`
	// shape.
	const caseTypeSchemas = buildCaseTypeMap(args.blueprint);
	for (const caseType of caseTypes) {
		try {
			await withTransientRetry(() =>
				store.applySchemaChange({
					appId: args.appId,
					caseType: caseType.name,
					caseTypeSchemas,
					...(args.syncedSeq !== undefined && { syncedSeq: args.syncedSeq }),
				}),
			);
		} catch (error) {
			// A deterministic fault (identifier collision, `CaseTypeNotInBlueprintError`)
			// would fail identically on every heal — surface it so a build doesn't
			// complete-and-charge over a permanently-unusable schema. Only a
			// still-transient terminal (retry exhausted on a sustained outage) is
			// swallowed; the heal re-syncs it on recovery.
			if (!isTransientDbError(error)) {
				throw error;
			}
			log.warn(
				"[materializeCaseStoreSchemas] per-type sync failed (transient)",
				{
					appId: args.appId,
					caseType: caseType.name,
					syncedSeq: args.syncedSeq,
					error,
				},
			);
		}
	}
}
