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
 * ## Saga shape
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
 * Callers that already loaded the app document (the auto-save
 * PUT route does so for its ownership check) pass the prior
 * blueprint via `args.priorBlueprint` — the saga uses it
 * directly, no second Firestore read. Callers without a
 * pre-loaded snapshot (the MCP path's `McpContext.saveBlueprint`)
 * omit the field, and the saga loads the doc itself. The auto-
 * save PUT path costs one Firestore read end-to-end (the
 * ownership-check load that's then threaded through); the MCP
 * path costs the saga's internal load.
 */

import type { CaseStore } from "@/lib/case-store";
import { buildCaseTypeMap, withOwnerContext } from "@/lib/case-store";
import {
	describeIntroducedErrors,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { rebuildFieldParent, toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import { log } from "@/lib/logger";
import {
	loadApp,
	updateApp,
	updateAppForRun,
	updateAppForRunTransactional,
	updateAppGuardedByBasis,
} from "./apps";
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
 *
 * `priorBlueprint` lets a caller that already loaded the app
 * document (the auto-save PUT route does so for ownership) skip
 * the saga's internal `loadApp` round trip. Absent: the saga
 * loads the prior blueprint itself. Supplying it on every awaited
 * blueprint write that already paid the load cost halves the
 * Firestore-read budget on hot edit paths.
 */
export interface ApplyBlueprintChangeArgs {
	readonly appId: string;
	readonly userId: string;
	readonly prospective: PersistableDoc;
	readonly runId?: string;
	readonly hint?: SchemaChangeHint;
	readonly priorBlueprint?: PersistableDoc;
	/**
	 * Guarded-commit mode (the MCP surface): instead of overwriting the
	 * blueprint with `prospective` blind, the Firestore commit becomes a
	 * transactional read-evaluate-write — re-apply `mutations` to the
	 * FRESH stored blueprint and re-run the validity verdict against it
	 * before writing. A concurrent committed batch therefore can't be
	 * silently erased (the recomputed doc builds ON the fresh state),
	 * and a batch the fresh verdict rejects throws
	 * {@link BlueprintCommitRejectedError} with nothing written.
	 * Requires `runId` (the guarded writer persists it alongside).
	 *
	 * `prospective` still drives the Postgres schema diff: the entry set
	 * derives from the mutations, so on the rare commit race the synced
	 * schema can momentarily trail the recomputed blueprint — the next
	 * successful save re-syncs, the same eventual-consistency posture the
	 * saga already documents for per-row migrations.
	 */
	readonly guard?: {
		readonly mutations: Mutation[];
	};
	/**
	 * Optimistic-basis mode (the browser auto-save PUT): the Firestore
	 * commit becomes a transactional compare-and-overwrite — the stored
	 * `blueprint_token` must equal `token` (the basis the client's doc
	 * snapshot was built on) or the write throws
	 * {@link BlueprintBasisStaleError} with nothing written, so a blind
	 * whole-doc save can't erase a write the client never saw (another
	 * tab, an MCP commit). On success the token rotates; the new value
	 * rides back on the result so the client advances its basis.
	 * Mutually exclusive with `guard` (mutation-bearing writers re-verdict
	 * instead of comparing a basis).
	 */
	readonly basis?: {
		readonly token: string | null;
	};
}

/**
 * Result of `applyBlueprintChange`. `basisToken` is present only on the
 * basis-guarded path — the freshly rotated token the client echoes on
 * its next save.
 */
export interface ApplyBlueprintChangeResult {
	readonly basisToken?: string;
}

/**
 * Thrown by the guarded commit when the validity verdict — re-run inside
 * the Firestore transaction against the freshly read blueprint — rejects
 * the batch. Carries the person-to-person findings as its message; the
 * MCP tool's catch returns it in the standard `{ error }` envelope, the
 * same shape an optimistic gate rejection produces.
 */
export class BlueprintCommitRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BlueprintCommitRejectedError";
	}
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
): Promise<ApplyBlueprintChangeResult> {
	const priorBlueprint = await resolvePriorBlueprint(args);
	const prospectiveBlueprint = args.prospective as BlueprintDoc;

	const entries = classifyCaseTypeChanges({
		prior: priorBlueprint,
		prospective: prospectiveBlueprint,
		hint: args.hint,
	});

	// Fast path — pure non-case-type mutation, skip Postgres
	// entirely and commit Firestore directly.
	if (entries.length === 0) {
		return await persistBlueprint(args);
	}

	const store = await withOwnerContext(args.userId);

	// Build the case-type schema map once at the boundary; the
	// case-store's `applySchemaChange` reads from it directly. Each
	// loop iteration shares the same prospective map.
	const prospectiveSchemas = buildCaseTypeMap(prospectiveBlueprint);

	// Phase 1: forward apply each change against Postgres. Track
	// which entries succeeded so a failure mid-loop compensates
	// only the ones that actually landed.
	const applied: CaseTypeChangeEntry[] = [];
	try {
		for (const entry of entries) {
			await store.applySchemaChange({
				appId: args.appId,
				caseType: entry.caseType,
				caseTypeSchemas: prospectiveSchemas,
				...(entry.property !== undefined && { property: entry.property }),
				...(entry.change !== undefined && { change: entry.change }),
			});
			applied.push(entry);
		}
	} catch (forwardErr) {
		await compensate(args.appId, store, applied, priorBlueprint);
		throw forwardErr;
	}

	// Phase 2: commit Firestore. On failure, compensate every
	// already-applied Postgres entry against the prior blueprint.
	try {
		return await persistBlueprint(args);
	} catch (commitErr) {
		await compensate(args.appId, store, applied, priorBlueprint);
		throw commitErr;
	}
}

/**
 * Resolve the prior blueprint snapshot the diff runs against.
 * When the caller supplies `priorBlueprint` (the auto-save PUT
 * route already loaded the doc for the ownership check), use it
 * directly — saves a Firestore round trip on every save. Without
 * it (the MCP path's `McpContext.saveBlueprint`), the saga loads
 * the doc itself.
 *
 * The `as BlueprintDoc` cast at the type boundary widens
 * `PersistableDoc` (Zod-inferred, no `fieldParent`) to the
 * in-memory shape (`PersistableDoc & { fieldParent: ... }`). The
 * `case-store` reads `caseTypes` only, so the missing
 * `fieldParent` is sound — the cast is the single seam.
 */
async function resolvePriorBlueprint(
	args: ApplyBlueprintChangeArgs,
): Promise<BlueprintDoc> {
	if (args.priorBlueprint !== undefined) {
		return args.priorBlueprint as BlueprintDoc;
	}
	const priorDoc = await loadApp(args.appId);
	if (priorDoc === null) {
		throw new Error(
			`[applyBlueprintChange] prior app document missing for appId=${args.appId}`,
		);
	}
	return priorDoc.blueprint as BlueprintDoc;
}

/**
 * Commit the prospective blueprint to Firestore. Routes through the
 * guarded transactional writer when a `guard` is supplied (MCP tool
 * calls), the basis-compare writer when a `basis` is supplied (the
 * auto-save PUT), `updateAppForRun` when only a `runId` is supplied, and
 * `updateApp` otherwise.
 */
async function persistBlueprint(
	args: ApplyBlueprintChangeArgs,
): Promise<ApplyBlueprintChangeResult> {
	if (args.guard !== undefined && args.runId !== undefined) {
		const { mutations } = args.guard;
		await updateAppForRunTransactional(args.appId, args.runId, (fresh) => {
			/* Re-apply against the FRESH stored blueprint and re-run the
			 * verdict inside the transaction. Firestore re-runs this body on
			 * contention, so the verdict always holds against the doc the
			 * write replaces. */
			const freshDoc: BlueprintDoc = {
				...(fresh.blueprint as PersistableDoc),
				fieldParent: {},
			} as BlueprintDoc;
			rebuildFieldParent(freshDoc);
			const verdict = mutationCommitVerdict(freshDoc, mutations);
			if (!verdict.ok) {
				throw new BlueprintCommitRejectedError(
					describeIntroducedErrors(verdict.introduced),
				);
			}
			return toPersistableDoc(verdict.nextDoc);
		});
		return {};
	}
	if (args.basis !== undefined) {
		const basisToken = await updateAppGuardedByBasis(
			args.appId,
			args.prospective,
			args.basis.token,
		);
		return { basisToken };
	}
	if (args.runId !== undefined) {
		await updateAppForRun(args.appId, args.prospective, args.runId);
	} else {
		await updateApp(args.appId, args.prospective);
	}
	return {};
}

/**
 * Run compensating case-store calls against the prior blueprint
 * state for every already-applied entry.
 *
 * Two compensation arms based on whether the case type existed
 * in the prior blueprint:
 *
 *   - **Case-type already existed in prior** — call
 *     `applySchemaChange(prior)` to regenerate the prior schema
 *     + emit the prior index DDL diff. Re-derives Postgres
 *     state from the prior snapshot.
 *   - **Case-type was added in prospective** (absent from prior)
 *     — call `dropSchema` to DELETE the `case_type_schemas` row
 *     + drop every per-property index. Routing through
 *     `applySchemaChange(prior)` here would throw
 *     `CaseTypeNotInBlueprintError` because the prior blueprint
 *     has no `caseTypes` entry to derive a schema from; the
 *     direct DROP is the only path that honors the saga's
 *     "exactly the prior state" contract.
 *
 * The compensation re-derives the `case_type_schemas` row + the
 * per-property indexes from the prior snapshot. Per-row
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
	store: CaseStore,
	applied: readonly CaseTypeChangeEntry[],
	priorBlueprint: BlueprintDoc,
): Promise<void> {
	if (applied.length === 0) return;
	// Build the prior schema map once for the loop; every entry's
	// presence-check + applySchemaChange call reads from the same
	// snapshot.
	const priorSchemas = buildCaseTypeMap(priorBlueprint);
	for (const entry of applied) {
		try {
			if (priorSchemas.has(entry.caseType)) {
				// Case type existed in prior — re-sync the schema for
				// the prior state. The per-row migration ran in Phase
				// 1, so passing `change` again would attempt a second
				// migration against rows that already migrated.
				// Schema-sync-only against the prior blueprint is the
				// inverse: it regenerates the prior JSON Schema + emits
				// the prior index DDL diff.
				await store.applySchemaChange({
					appId,
					caseType: entry.caseType,
					caseTypeSchemas: priorSchemas,
				});
			} else {
				// Case type was added in prospective — drop the schema
				// row + per-property indexes directly. Routing through
				// `applySchemaChange(prior)` here would throw
				// `CaseTypeNotInBlueprintError` (prior blueprint has no
				// matching `caseTypes` entry to derive a schema from);
				// `dropSchema` is the structural inverse for the case-
				// type-addition arm.
				await store.dropSchema({ appId, caseType: entry.caseType });
			}
		} catch (compensateErr) {
			log.error(
				`[applyBlueprintChange] compensation failed for caseType=${entry.caseType}`,
				compensateErr,
				{ appId },
			);
		}
	}
}
