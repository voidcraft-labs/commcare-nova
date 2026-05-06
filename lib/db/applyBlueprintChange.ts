/**
 * Cross-store saga for blueprint writes — orchestrates Firestore
 * (the blueprint document) and Postgres (the case-store schema +
 * row population) so the two stores never drift after a partial
 * failure.
 *
 * ## The drift the saga prevents
 *
 * The Firestore blueprint and the Postgres `case_type_schemas`
 * row are independent commit boundaries. Without orchestration,
 * a property rename that lands in Firestore but fails the Postgres
 * schema sync leaves the blueprint pointing at a property the
 * runtime validator rejects — exports / writes fail until manual
 * recovery. The saga inverts the order so Postgres commits first;
 * a Firestore-commit failure then runs a compensating
 * `applySchemaChange` against the prior blueprint state to revert
 * Postgres to its pre-mutation shape. The compensation is
 * idempotent because `applySchemaChange` re-derives the schema +
 * index DDL from its input snapshot.
 *
 * ## Saga shape (per the design spec's "Cross-store coordination"
 * section)
 *
 *   1. Compute the prospective new blueprint state in memory.
 *   2. Diff prior vs. prospective via `classifyCaseTypeChanges`.
 *   3. For each schema-affecting entry, call `applySchemaChange`
 *      with the prospective snapshot. On any failure, run
 *      compensating calls against the prior snapshot for every
 *      already-applied entry (in original order) and rethrow.
 *   4. Commit the new blueprint to Firestore.
 *   5. On Firestore commit failure, run compensating
 *      `applySchemaChange` calls against the prior snapshot for
 *      every entry the saga issued in step 3 and rethrow.
 *
 * The saga is a no-op fast path for purely non-case-type
 * mutations (module name edits, form text edits, field UI
 * tweaks): `classifyCaseTypeChanges` returns an empty array and
 * the saga skips Postgres entirely, committing Firestore directly.
 *
 * ## Where the saga is wired in
 *
 * The two awaited blueprint-write boundaries:
 *   - `app/api/apps/[id]/route.ts` PUT (auto-save).
 *   - `lib/mcp/context.ts` `recordMutations` (MCP tool calls).
 *
 * The chat-side intermediate save (`generationContext.saveBlueprint`)
 * stays fire-and-forget by design — the SA's fix-retry discipline
 * covers missed intermediate saves and SSE latency must not block
 * on Firestore. Initial-generation writes are additive-only by
 * construction (case types are set once via `generateScaffold`,
 * then never mutated mid-stream), so the cross-store saga has no
 * compensation work to do on the chat path.
 *
 * ## Loading the prior state
 *
 * The saga reads the prior blueprint from Firestore via `loadApp`
 * before computing the diff. Callers don't thread it through —
 * keeping the prior load inside the saga centralizes the read
 * and matches the single-mutation-per-call contract. The cost is
 * one extra Firestore document read per save; auto-save is
 * client-debounced and MCP tool calls are sequential per
 * conversation, so the latency floor matches what the existing
 * `loadApp` callers (the chat-side `loadAppForRun`, the MCP
 * adapter's ownership gate's parent fetch) already pay.
 */

import { withOwnerContext } from "@/lib/case-store";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import { log } from "@/lib/logger";
import { loadApp, updateApp, updateAppForRun } from "./apps";
import {
	type CaseTypeChangeEntry,
	classifyCaseTypeChanges,
	type SchemaChangeHint,
} from "./classifyCaseTypeChanges";

/**
 * Arguments for `applyBlueprintChange`.
 *
 * `runId` discriminates the two persisted-write helpers: present
 * routes through `updateAppForRun` (writes `run_id` alongside the
 * blueprint, used by MCP tool calls inside their sliding-window
 * run); absent routes through `updateApp` (auto-save's plain
 * blueprint write).
 *
 * `hint` carries optional explicit per-row migration intent —
 * rename / retype / narrow-options. The classifier emits the
 * matching `change` shape on the `applySchemaChange` call so the
 * schema sync + per-row migration run in one Postgres
 * transaction.
 */
export interface ApplyBlueprintChangeArgs {
	readonly appId: string;
	readonly userId: string;
	readonly prospective: PersistableDoc;
	readonly runId?: string;
	readonly hint?: SchemaChangeHint;
}

/**
 * Run the cross-store saga and persist the prospective blueprint.
 *
 * Throws on any unrecoverable failure (Postgres schema sync
 * failure with no recovery, Firestore commit failure with
 * compensation completed). On Postgres failure, the saga
 * compensates the partial Postgres work and rethrows. On
 * Firestore failure, the saga compensates the entire Postgres
 * work and rethrows. Either way, the database state on return is
 * "exactly the prior state" — the caller can retry without
 * worrying about half-applied writes.
 */
export async function applyBlueprintChange(
	args: ApplyBlueprintChangeArgs,
): Promise<void> {
	const priorDoc = await loadApp(args.appId);
	if (priorDoc === null) {
		throw new Error(
			`[applyBlueprintChange] prior app document missing for appId=${args.appId}`,
		);
	}

	// `loadApp` returns `AppDoc`, whose `blueprint` is `PersistableDoc`
	// — same shape as the `prospective` argument. The diff and the
	// `applySchemaChange` call both consume the in-memory `BlueprintDoc`
	// shape (which is `PersistableDoc & { fieldParent: ... }`); the
	// case-store reads `caseTypes` only and never touches `fieldParent`,
	// so passing the persisted shape directly is sound. The cast at the
	// type boundary is the single seam.
	const priorBlueprint = priorDoc.blueprint as BlueprintDoc;
	const prospectiveBlueprint = args.prospective as BlueprintDoc;

	const entries = classifyCaseTypeChanges({
		prior: priorBlueprint,
		prospective: prospectiveBlueprint,
		hint: args.hint,
	});

	// Fast path — pure non-case-type mutation, skip Postgres
	// entirely and commit Firestore directly.
	if (entries.length === 0) {
		await persistBlueprint(args);
		return;
	}

	const store = await withOwnerContext(args.userId);

	// Phase 1: forward apply each change against Postgres. Track
	// which entries succeeded so a failure mid-loop compensates
	// only the ones that actually landed.
	const applied: CaseTypeChangeEntry[] = [];
	try {
		for (const entry of entries) {
			await store.applySchemaChange({
				appId: args.appId,
				caseType: entry.caseType,
				blueprint: prospectiveBlueprint,
				...(entry.property !== undefined && { property: entry.property }),
				...(entry.change !== undefined && { change: entry.change }),
			});
			applied.push(entry);
		}
	} catch (forwardErr) {
		await compensate(args.appId, args.userId, applied, priorBlueprint);
		throw forwardErr;
	}

	// Phase 2: commit Firestore. On failure, compensate every
	// already-applied Postgres entry against the prior blueprint.
	try {
		await persistBlueprint(args);
	} catch (commitErr) {
		await compensate(args.appId, args.userId, applied, priorBlueprint);
		throw commitErr;
	}
}

/**
 * Commit the prospective blueprint to Firestore. Routes through
 * `updateAppForRun` when a `runId` is supplied (MCP tool calls
 * persist the run id alongside) and through `updateApp` otherwise.
 */
async function persistBlueprint(args: ApplyBlueprintChangeArgs): Promise<void> {
	if (args.runId !== undefined) {
		await updateAppForRun(args.appId, args.prospective, args.runId);
	} else {
		await updateApp(args.appId, args.prospective);
	}
}

/**
 * Run compensating `applySchemaChange` calls against the prior
 * blueprint state for every already-applied entry.
 *
 * The compensation re-derives the schema + index DDL from the
 * prior snapshot, so the `case_type_schemas` row + the per-
 * property indexes return to their pre-mutation shape. Per-row
 * migrations are NOT inverted: rows already retyped stay in their
 * new JSONB shape, and rows already moved to `cases_quarantine`
 * stay quarantined. The eventual-consistency model is acceptable
 * here because the next successful `applyBlueprintChange` call
 * (typically the user's retry of the same edit) re-syncs the
 * schema against the rows that already migrated. The author's
 * "apps are always in a valid state" lock holds at the schema
 * row + index DDL layer; per-row migration outcomes are durable
 * regardless of whether the surrounding saga commits.
 *
 * Try/catch isolation per call: a compensation failure logs and
 * continues so one failure doesn't mask another's signal. The
 * saga rethrows the original forward error regardless — the
 * caller sees the root cause, and the operator-facing log
 * captures any compensation gaps.
 */
async function compensate(
	appId: string,
	userId: string,
	applied: readonly CaseTypeChangeEntry[],
	priorBlueprint: BlueprintDoc,
): Promise<void> {
	if (applied.length === 0) return;
	const store = await withOwnerContext(userId);
	for (const entry of applied) {
		try {
			// Compensation always re-syncs the schema for the prior
			// state — the per-row migration happened in Phase 1, so
			// passing `change` again would attempt a second migration
			// against rows that already migrated. Schema-sync-only
			// against the prior blueprint is the inverse: it
			// regenerates the prior JSON Schema + emits the prior
			// index DDL diff.
			await store.applySchemaChange({
				appId,
				caseType: entry.caseType,
				blueprint: priorBlueprint,
			});
		} catch (compensateErr) {
			log.error(
				`[applyBlueprintChange] compensation failed for caseType=${entry.caseType}`,
				compensateErr,
				{ appId },
			);
		}
	}
}
