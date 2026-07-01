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
 * The chat surface does NOT route through this saga: each tool batch
 * commits inline through `commitGuardedBatch` directly (awaited), and
 * the chat route's drain-end finalize re-syncs the case-store schemas
 * in one pass for whatever the run persisted — so the chat path needs
 * no per-save saga.
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

import { produce } from "immer";
import type { SchemaCaseStore } from "@/lib/case-store";
import { buildCaseTypeMap, withSchemaContext } from "@/lib/case-store";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	PersistableDoc,
	PersistedBlueprint,
} from "@/lib/domain";
import { log } from "@/lib/logger";
import type { MediaAttachExpectation } from "@/lib/media/attachVerdicts";
import { commitGuardedBatch, loadApp } from "./apps";
import {
	type CaseTypeChangeEntry,
	classifyCaseTypeChanges,
	type SchemaChangeHint,
} from "./classifyCaseTypeChanges";
import { docs } from "./firestore";
import type { AcceptedMutationDoc } from "./types";

/**
 * Arguments for `applyBlueprintChange`.
 *
 * `runId` distinguishes a run-scoped write from a standalone one; it rides the
 * durable stream entry. Every path routes the Firestore write through the one
 * guarded commit ({@link commitGuardedBatch}) — the transactional
 * read-evaluate-write below — after the Postgres schema saga.
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
	/**
	 * The whole prospective doc — supplied by the chat build/edit + MCP
	 * paths. The guarded MUTATION path (auto-save) omits it and sends
	 * `guard.mutations` instead; the saga derives the prospective by
	 * replaying those on the prior for the case-type diff.
	 */
	readonly prospective?: PersistedBlueprint;
	readonly runId?: string;
	/** Client-minted idempotency key for this whole change — pairs with the
	 *  `batchDedup/{batchId}` latch. A top-level dedup hit short-circuits the
	 *  Postgres saga; {@link commitGuardedBatch}'s in-txn latch is the durable
	 *  guard. */
	readonly batchId: string;
	/** Which write path is committing — stamped on the durable stream entry. */
	readonly kind: AcceptedMutationDoc["kind"];
	readonly hint?: SchemaChangeHint;
	readonly priorBlueprint?: PersistableDoc;
	/**
	 * Guarded MUTATION commit: the Firestore write is a transactional
	 * read-evaluate-write — re-apply `mutations` onto the FRESH stored
	 * blueprint and re-run the validity verdict before writing. A
	 * concurrent committed batch can't be erased (the recomputed doc
	 * builds ON the fresh state — the non-destructive merge), and a batch
	 * the fresh verdict rejects throws {@link BlueprintCommitRejectedError}
	 * with nothing written. With `runId` it routes through the run-scoped
	 * writer (MCP tool calls); without one, through the tokenless
	 * auto-save writer that rotates + returns the basis token.
	 */
	readonly guard?: {
		readonly mutations: Mutation[];
		/**
		 * Media-attach expectations to re-verify INSIDE the transaction
		 * (see `lib/media/attachVerdicts.ts`). The asset rows are read via
		 * the transaction itself — joining its read set — so an asset
		 * delete racing the attach serializes against this commit instead
		 * of leaving a dangling reference. A failed expectation throws
		 * {@link BlueprintCommitRejectedError} with the same
		 * person-to-person message the pre-commit verdict produces.
		 */
		readonly mediaExpectations?: readonly MediaAttachExpectation[];
	};
}

/**
 * Result of `applyBlueprintChange`. `basisToken` is the freshly rotated
 * `blueprint_token` the client tracks as the latest server version; `seq` is
 * the `mutation_seq` the batch committed at. `committedDoc` is the hydrated
 * committed doc — absent only on a TOP-LEVEL dedup hit (which returns the
 * recorded seq/basis without paying the app-doc read; the in-txn dedup inside
 * {@link commitGuardedBatch} does supply it).
 */
export interface ApplyBlueprintChangeResult {
	readonly basisToken?: string;
	readonly seq: number;
	readonly committedDoc?: BlueprintDoc;
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
	// Top-level idempotency: a re-delivered batch (a client retry) whose latch
	// already exists short-circuits the whole cross-store saga. The read is
	// non-transactional — a batch that commits between here and the guarded
	// write is still caught by `commitGuardedBatch`'s in-transaction latch. A
	// hit returns the recorded seq/basis with no `committedDoc` (skips the
	// app-doc read); MCP/auto-save tolerate its absence on a dedup hit.
	const dedup = await docs.batchDedupRaw(args.appId, args.batchId).get();
	if (dedup.exists) {
		const latch = dedup.data() as { seq: number; basisToken: string };
		return { seq: latch.seq, basisToken: latch.basisToken };
	}
	const priorBlueprint = await resolvePriorBlueprint(args);
	/* The prospective doc drives the case-type diff below. The whole-doc
	 * paths supply it directly (the double hop steps the walled
	 * `PersistedBlueprint` back up to `PersistableDoc`; a direct cast can't
	 * compile because the wall's `never` slots don't overlap `BlueprintDoc`'s
	 * required `fieldParent`). The guarded MUTATION path sends no whole doc —
	 * derive it by replaying the mutations on the prior. The Firestore commit
	 * re-applies on the FRESH doc, so a concurrent writer can make this
	 * prior-based derivation momentarily trail; only `caseTypes` is read from
	 * it (for the Postgres diff), and the next save re-syncs — the same
	 * eventual consistency the per-row migrations already document. */
	const prospectiveBlueprint: BlueprintDoc =
		args.prospective !== undefined
			? (args.prospective as PersistableDoc as BlueprintDoc)
			: produce(priorBlueprint, (draft) => {
					applyMutations(draft, args.guard?.mutations ?? []);
				});

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

	// Tenant-free schema store: the saga only ever calls
	// `applySchemaChange` / `dropSchema`, both app-scoped, so it binds no
	// Project. (The media-expectation re-check inside the Firestore
	// transaction below scopes to the fresh app doc's `project_id`.)
	const store = await withSchemaContext();

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
 * Commit the blueprint through the unified guarded writer. Every caller of the
 * saga now supplies a `guard` (the whole-doc non-guard path is gone); the
 * transactional re-apply-on-fresh + re-verdict + concurrent-delete guard +
 * media re-check + durable stream + dedup latch + `mutation_seq` advance all
 * live in {@link commitGuardedBatch}. `run_id` (MCP) rides along; auto-save
 * omits it. Returns the rotated basis, the committed `seq`, and the hydrated
 * committed doc for the caller to surface.
 */
async function persistBlueprint(
	args: ApplyBlueprintChangeArgs,
): Promise<ApplyBlueprintChangeResult> {
	if (args.guard === undefined) {
		throw new Error("[applyBlueprintChange] a persist requires a `guard`");
	}
	const { mutations, mediaExpectations } = args.guard;
	const result = await commitGuardedBatch({
		appId: args.appId,
		batchId: args.batchId,
		...(args.runId !== undefined && { runId: args.runId }),
		mutations,
		actorUserId: args.userId,
		kind: args.kind,
		...(mediaExpectations !== undefined && { mediaExpectations }),
	});
	return {
		basisToken: result.basisToken,
		seq: result.seq,
		committedDoc: result.committedDoc,
	};
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
	store: SchemaCaseStore,
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
