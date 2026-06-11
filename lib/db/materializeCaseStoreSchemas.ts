/**
 * Materialize the case-store schema rows + per-property indexes
 * for every case type in a freshly-completed blueprint.
 *
 * ## What this closes
 *
 * The SA's chat-side `saveBlueprint` writes Firestore fire-and-
 * forget on every mutation (intentionally — the SA's fix-retry
 * loop covers missed intermediate saves and SSE latency must not
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
 * This helper is called once at the chat-completion boundary
 * (the shared `completeBuild` tool's success arm),
 * BEFORE the `data-done` SSE emit and BEFORE the
 * fire-and-forget `completeApp` Firestore write. The ordering
 * matters:
 *
 *   1. Await this helper — UPSERTs the schema row + indexes for
 *      every case type. Blocks until Postgres is caught up.
 *   2. `data-done` SSE emit — UX signal that the SA is done; the
 *      client's stream dispatcher stamps `runCompletedAt` on
 *      this event, which drives the Completed celebration phase.
 *   3. `completeApp` — fire-and-forget Firestore status flip.
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
 * celebration sees a synced schema.
 *
 * ## Why no saga
 *
 * Pure additive — every case type is freshly-introduced. There is
 * no prior Postgres state to revert to on Firestore failure (the
 * app was just generated; nothing reads from `case_type_schemas`
 * before this call). The compensation surface
 * `applyBlueprintChange.ts` builds for awaited writes is
 * irrelevant here.
 *
 * ## Failure handling
 *
 * The helper itself surfaces throws unwrapped — a per-case-type
 * `applySchemaChange` failure stops the loop at the offending
 * case type and bubbles the error. The caller (`solutionsArchitect`'s
 * `completeBuild` wrapper) is responsible for routing the throw
 * through the canonical `classifyError` + `ctx.emitError` +
 * `failApp` path so the client sees `data-error`, the app
 * status flips to `error` immediately, and the SA loop sees a
 * clean `success: false` return that doesn't invite another
 * retry. Swallowing failures here would relocate the
 * Schema-not-synced gap this helper exists to close.
 */

import { buildCaseTypeMap, withOwnerContext } from "@/lib/case-store";
import type { PersistableDoc } from "@/lib/domain";

/**
 * Arguments for `materializeCaseStoreSchemas`. The blueprint is
 * the freshly-completed snapshot the build produced; it
 * carries the canonical `caseTypes` list the helper iterates.
 * The SA wrapper passes the same snapshot into the subsequent
 * `data-done` SSE emit so the client's reconciliation matches
 * what Postgres just landed.
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
