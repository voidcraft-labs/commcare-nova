/**
 * Materialize the case-store schema rows + per-property indexes
 * for every case type a chat run's blueprint carries.
 *
 * ## What this closes
 *
 * The SA's chat-side `saveBlueprint` writes Firestore fire-and-
 * forget on every mutation (intentionally — SSE latency must not
 * block on Firestore). That fire-and-forget path never calls
 * `applySchemaChange`, so `case_type_schemas` carries no row for
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
 * they call `withOwnerContext` and dispatch directly. If
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
 * The helper itself surfaces throws unwrapped — a per-case-type
 * `applySchemaChange` failure stops the loop at the offending
 * case type and bubbles the error. The chat route's build arm
 * routes the throw through `failRun` (classify + emit + refund +
 * `failApp`) so the client sees the error and no celebration fires
 * over an unsynced store; the edit arm logs it (the edit itself
 * succeeded), and the gap closes at the point of use — every
 * case-store consumer that can hit `SchemaNotSyncedError`
 * (sample-populate, form submit, live preview) re-runs this helper
 * from the persisted blueprint and retries once (`withSchemaHeal`
 * in `lib/preview/engine/caseDataBindingHelpers.ts`). Swallowing
 * failures here would relocate the Schema-not-synced gap this
 * helper exists to close.
 */

import { buildCaseTypeMap, withOwnerContext } from "@/lib/case-store";
import type { PersistableDoc } from "@/lib/domain";

/**
 * Arguments for `materializeCaseStoreSchemas`. The blueprint is
 * the run's final persisted snapshot; it carries the canonical
 * `caseTypes` list the helper iterates. The route passes the same
 * snapshot into the subsequent `data-done` SSE emit so the
 * client's reconciliation matches what Postgres just landed.
 */
export interface MaterializeCaseStoreSchemasArgs {
	readonly appId: string;
	readonly userId: string;
	readonly blueprint: PersistableDoc;
}

/**
 * For every case type in `blueprint.caseTypes`, call
 * `applySchemaChange` with no `property` / `change` — the
 * additive arm that UPSERTs `case_type_schemas` and emits the
 * matching `CREATE INDEX CONCURRENTLY` statements for any per-
 * property indexes the case-type's `data_type` set declares.
 *
 * No-op when `caseTypes` is null (survey-only build) or empty.
 * The early return skips the `withOwnerContext` allocation so
 * a survey-only completion never pays the connection-pool
 * lookup cost for a loop that wouldn't issue any work.
 */
export async function materializeCaseStoreSchemas(
	args: MaterializeCaseStoreSchemasArgs,
): Promise<void> {
	const caseTypes = args.blueprint.caseTypes;
	if (caseTypes === null || caseTypes.length === 0) {
		return;
	}

	// `withOwnerContext` returns a `CaseStore` already bound to
	// the supplied owner id; every `applySchemaChange` call
	// inherits the tenant filter without a per-call argument.
	const store = await withOwnerContext(args.userId);

	// Sequential rather than parallel: each `applySchemaChange`
	// touches Postgres index DDL via `CREATE INDEX CONCURRENTLY`,
	// which doesn't lock writes but does serialize against
	// other catalog mutations per relation. Parallel calls would
	// only help if case types touched disjoint relations, but
	// every case type writes against the same `cases` heap.
	// Sequential keeps the semantics simple and the failure
	// reporting deterministic — a throw on case type N stops the
	// loop at N, the operator sees exactly which case type
	// failed.
	// `applySchemaChange` accepts the case-type schema map every
	// compiler in the case-store stack reads from; the boundary
	// builds it once from the persisted blueprint. `buildCaseTypeMap`
	// reads `caseTypes` only, so the `PersistableDoc` goes through
	// directly — no cast to the in-memory `BlueprintDoc` shape.
	const caseTypeSchemas = buildCaseTypeMap(args.blueprint);
	for (const caseType of caseTypes) {
		await store.applySchemaChange({
			appId: args.appId,
			caseType: caseType.name,
			caseTypeSchemas,
		});
	}
}
