/**
 * Materialize the case-store schema rows + per-property indexes
 * for every case type in a freshly-completed blueprint.
 *
 * ## What this closes
 *
 * The SA's chat-side `saveBlueprint` writes Firestore fire-and-
 * forget on every mutation (intentionally — `lib/agent/CLAUDE.md`
 * documents the SA fix-retry discipline that covers missed
 * intermediate saves; SSE latency must not block on Firestore).
 * That fire-and-forget path never calls `applySchemaChange`, so
 * `case_type_schemas` carries no row for any case type the SA
 * just generated. Until the user's first awaited write
 * (auto-save PUT or MCP tool call) routes through
 * `applyBlueprintChange` and lands the schema sync, every
 * case-store insert path fires `SchemaNotSyncedError`:
 *
 *   - `populateSampleCasesAction` (sample-data populate).
 *   - `submitFormAction` (form submit).
 *   - Live-preview panels that mount a `PostgresCaseStore` query.
 *
 * This helper is called once at the chat-completion boundary
 * (the `validateApp` success arm in `solutionsArchitect.ts`),
 * AFTER the `data-done` SSE emit and BEFORE the
 * fire-and-forget `completeApp` Firestore write that flips the
 * app's lifecycle status to `complete`. The ordering matters:
 *
 *   1. `data-done` — UX signal that the SA is done, the client
 *      can disable its progress affordance.
 *   2. Await this helper — any code path that next reads the
 *      app's `complete` status sees a synced Postgres schema.
 *   3. `completeApp` — fire-and-forget Firestore status flip.
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
 * ## Why awaited
 *
 * If `applySchemaChange` throws, propagate. Swallowing the error
 * just relocates the gap this helper exists to close — a
 * Postgres failure during chat completion is a real signal worth
 * surfacing to the operator-facing log and the SA tool's caller.
 * The chat stream's tool-call boundary surfaces the rejection as
 * a stream error, which is the correct propagation path.
 */

import { withOwnerContext } from "@/lib/case-store";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";

/**
 * Arguments for `materializeCaseStoreSchemas`. The blueprint is
 * the freshly-completed snapshot the SA just emitted via
 * `data-done`; it carries the canonical `caseTypes` list the
 * helper iterates.
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
	// `applySchemaChange` accepts the in-memory `BlueprintDoc`
	// shape (`PersistableDoc & { fieldParent: ... }`). The
	// case-store reads `caseTypes` only and never touches
	// `fieldParent`, so passing the persistable shape directly
	// is sound — the `as BlueprintDoc` cast here matches the
	// same pattern in `applyBlueprintChange.ts`.
	const blueprint = args.blueprint as BlueprintDoc;
	for (const caseType of caseTypes) {
		await store.applySchemaChange({
			appId: args.appId,
			caseType: caseType.name,
			blueprint,
		});
	}
}
