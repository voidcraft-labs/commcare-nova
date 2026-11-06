/**
 * Materialize the case-store schema rows
 * for every case type a chat run's blueprint carries.
 *
 * ## What this closes
 *
 * A run may finish with schema materialization still pending after a transient
 * database failure. Until that durable work and the final Blueprint
 * projection converge, case-store insert paths can fire
 * `SchemaNotSyncedError`:
 *
 *   - `populateSampleCasesAction` (sample-data populate).
 *   - `submitFormAction` (form submit).
 *   - Live-preview panels that mount a `PostgresCaseStore` query.
 *
 * The chat route's drain-end finalize calls this for the run's
 * final persisted doc (builds AND edits), BEFORE the build arm's
 * status flip and `data-done` SSE emit. The ordering matters:
 *
 *   1. Await this helper — UPSERTs the schema row for
 *      every case type. Blocks until Postgres is caught up.
 *   2. Build finalization atomically writes the status flip, kept-charge
 *      settlement, and (for a reviewed initial build) its `finished` event.
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
 * celebration sees a synced schema. (On MCP, the guarded commit boundary
 * covers the same contract — a
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
 * The operation is an idempotent latest-state projection. It passes no
 * caller-intent migration; any detected same-name type transition remains
 * atomic with the stored schema update.
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
import {
	CASE_CLAIM_CASE_TYPE,
	type PersistableDoc,
	USERCASE_CASE_TYPE,
} from "@/lib/domain";
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

/** Materialize every case schema from the same persisted Blueprint snapshot. */
export async function materializeCaseStoreSchemas(
	args: MaterializeCaseStoreSchemasArgs,
): Promise<void> {
	const store = await withSchemaContext();
	// Every app gets the worker's own case, INCLUDING a survey-only one. HQ
	// gives every worker a usercase whatever the app collects, `#user/<prop>`
	// reads it through a `casedb` join rather than a projection, and a persona
	// exists on apps with no case types at all. Materializing it
	// unconditionally is also what lets the read path stay branch-free: there
	// is no "has this app got a usercase schema yet" question to get wrong.
	// A search's claim is a case row of its own type (`lib/domain/caseClaim.ts`)
	// that any app's Preview may write, so its schema row is born here too.
	const caseTypes = args.blueprint.caseTypes ?? [];

	// Schema admission and data transitions commit together. Each type uses
	// the same persisted revision and retries only transient database faults.
	const caseTypeSchemas = buildCaseTypeMap(args.blueprint);
	for (const caseType of [
		...caseTypes,
		{ name: USERCASE_CASE_TYPE },
		{ name: CASE_CLAIM_CASE_TYPE },
	]) {
		try {
			const report = await withTransientRetry(() =>
				store.applySchemaChange({
					appId: args.appId,
					caseType: caseType.name,
					caseTypeSchemas,
					...(args.syncedSeq !== undefined && { syncedSeq: args.syncedSeq }),
				}),
			);
			// This boundary has no user-facing response channel (it runs at
			// drain end / heal), so a sync whose write-time detection SET
			// VALUES ASIDE logs loudly — the values stay recoverable in
			// `parked_case_values`, but a silent park here would otherwise
			// be invisible until the review surface ships.
			if (report.parkedIds.length > 0) {
				log.warn("[materializeCaseStoreSchemas] sync parked case values", {
					appId: args.appId,
					caseType: caseType.name,
					parked: report.parkedIds.length,
					failureReasons: report.failureReasons,
				});
			}
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
