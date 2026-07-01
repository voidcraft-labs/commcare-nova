/**
 * Cross-store saga for blueprint writes — orchestrates Firestore
 * (the blueprint document) and Postgres (the case-store schema +
 * row population) so the two stores never drift under concurrency.
 *
 * ## The two-arm sync
 *
 * Concurrent additive case-type edits must both materialize
 * without either losing a per-row migration. The sync splits
 * `classifyCaseTypeChanges`'s entries by change kind:
 *
 *   - **Migration-bearing** entries (a `change` hint — a rename /
 *     retype / narrow-options reshape, single-actor by nature):
 *     run Postgres-first + `compensate()` BEFORE the commit,
 *     derived from the client prospective. The per-row migration
 *     is recoverable — a failure runs a compensating
 *     `applySchemaChange` derived from the CURRENT committed doc
 *     (a fresh `loadApp`), seq-guarded, so it restores the schema
 *     row + index DDL without dropping a concurrent peer's
 *     committed property.
 *   - **Additive** entries (a property/type add, no `change`):
 *     run a single POST-COMMIT sweep against the COMMITTED doc.
 *     After `commitGuardedBatch` returns, sync every case type the
 *     classify entries name at `syncedSeq = the committed seq`.
 *     The monotone `synced_seq` guard makes two concurrently-added
 *     properties converge — the sweep re-derives the full schema
 *     from `committedDoc`, so a peer's concurrently-committed
 *     property is picked up rather than clobbered, and a stale
 *     lower-seq sync fully no-ops.
 *
 * The additive sweep is additive-only (no per-row migration,
 * nothing to compensate). A sweep failure logs at `warn` and
 * returns success — it is idempotent and re-derivable via the
 * next save / the point-of-use heal.
 *
 * ## Saga shape
 *
 *   1. Compute the prospective new blueprint state in memory.
 *   2. Diff prior vs. prospective via `classifyCaseTypeChanges` and
 *      partition into migration-bearing vs. additive entries.
 *   3. If there ARE migration-bearing entries, reauthorize the actor
 *      against the app's Project BEFORE running their Phase-1 DDL — a
 *      deauth'd caller must not mutate `case_type_schemas` before
 *      `commitGuardedBatch`'s own reauth would reject. A pure additive
 *      / non-case-type commit runs no pre-commit DDL, so it skips this
 *      gate and relies on `commitGuardedBatch`'s reauth alone.
 *   4. Run the MIGRATION-BEARING entries Postgres-first against the
 *      prospective; a mid-loop failure compensates the already-applied
 *      ones and rethrows.
 *   5. Commit the new blueprint to Firestore (`commitGuardedBatch`).
 *      On failure, compensate every migration-bearing entry from the
 *      current committed doc (seq-guarded) and rethrow.
 *   6. Unless the commit deduped, sweep every touched case type
 *      against the committed doc at the committed seq (post-commit,
 *      swallow + warn).
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
import { commitGuardedBatch, loadApp, loadAppProjectId } from "./apps";
import {
	type CaseTypeChangeEntry,
	classifyCaseTypeChanges,
	type SchemaChangeHint,
} from "./classifyCaseTypeChanges";
import { reauthorizeActorForCommit } from "./commitGuard";
import { docs } from "./firestore";
import { isTransientDbError } from "./schemaSyncRetry";
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
	 * the fresh verdict rejects throws `BlueprintCommitRejectedError`
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
		 * `BlueprintCommitRejectedError` with the same person-to-person
		 * message the pre-commit verdict produces.
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
 * Throws on any unrecoverable failure of the migration-bearing arm
 * (its Postgres schema sync failing with no recovery, or a
 * Firestore commit failure after its compensation completed). On
 * either, the migration-bearing Postgres work is compensated back
 * to the prior state and the original error rethrows — the caller
 * can retry without half-applied writes. The additive post-commit
 * sweep never throws (swallow + warn); an additive gap self-heals
 * on the next save.
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

	// Fast path — pure non-case-type mutation, skip Postgres entirely and
	// commit Firestore directly. `commitGuardedBatch`'s own reauth is the
	// single gate here (no pre-commit DDL to protect).
	if (entries.length === 0) {
		return (await persistBlueprint(args)).result;
	}

	// Tenant-free schema store: the saga only ever calls
	// `applySchemaChange` / `dropSchema`, both app-scoped, so it binds no
	// Project. (The media-expectation re-check inside the Firestore
	// transaction below scopes to the fresh app doc's `project_id`.)
	const store = await withSchemaContext();

	// The migration-bearing entries run Postgres-first + compensate; the
	// additive ones ride the post-commit sweep. `change !== undefined` is the
	// discriminator the classifier stamps for an explicit per-row reshape. A
	// hint whose `caseType` isn't in the prospective (a stale / retired-type
	// hint) is dropped — running it would throw `CaseTypeNotInBlueprintError`
	// and abort an otherwise-valid write; the sweep (or the next save) still
	// covers whatever the committed doc holds.
	const prospectiveSchemas = buildCaseTypeMap(prospectiveBlueprint);
	const migrationEntries = entries.filter((entry) => {
		if (entry.change === undefined) return false;
		if (!prospectiveSchemas.has(entry.caseType)) {
			log.warn(
				"[applyBlueprintChange] migration hint targets a case type absent from the prospective blueprint — skipping",
				{ appId: args.appId, caseType: entry.caseType },
			);
			return false;
		}
		return true;
	});

	// Reauthorize BEFORE the migration-bearing Phase-1 DDL — ONLY when there is
	// such DDL to protect. The saga applies that DDL before
	// `commitGuardedBatch`'s own in-txn reauth would fire, so a caller
	// deauthorized mid-window must be rejected here or they'd mutate
	// `case_type_schemas` (and, if the compensating call also failed, leave
	// store drift). For a pure additive / non-case-type commit there is no
	// pre-commit DDL, so `commitGuardedBatch`'s reauth is the single gate — no
	// second `loadAppProjectId` + `projectRoleFor` round trip on the hot path.
	//
	// When it DOES run, the resolved `projectId` is threaded into the commit as
	// `preauthorized` so `commitGuardedBatch` doesn't re-run the identical
	// resolve + reauth for the same actor moments later.
	let preauthorized: { projectId: string | null } | undefined;
	if (migrationEntries.length > 0) {
		const projectId = await loadAppProjectId(args.appId);
		await reauthorizeActorForCommit(projectId, args.userId);
		preauthorized = { projectId };
	}

	// Phase 1: forward-apply each MIGRATION-BEARING change against Postgres,
	// derived from the client prospective. The additive entries are NOT applied
	// here — they wait for the post-commit sweep of the committed doc.
	//
	// On any failure, compensate over ALL `migrationEntries` (not just the ones
	// whose `applySchemaChange` fully returned): `applySchemaChange` is
	// two-phase, so an entry whose Phase A committed and whose Phase B then
	// threw exits this loop UN-recorded, yet its schema DID change. Compensate
	// is idempotent (it re-derives each type from the fresh committed doc), so
	// re-syncing a type whose Phase A rolled back is a harmless no-op while a
	// Phase-A-committed / Phase-B-failed type is correctly reconciled.
	try {
		for (const entry of migrationEntries) {
			await store.applySchemaChange({
				appId: args.appId,
				caseType: entry.caseType,
				caseTypeSchemas: prospectiveSchemas,
				...(entry.property !== undefined && { property: entry.property }),
				...(entry.change !== undefined && { change: entry.change }),
			});
		}
	} catch (forwardErr) {
		await compensate(args.appId, store, migrationEntries);
		throw forwardErr;
	}

	// Phase 2: commit Firestore. On failure, compensate every migration-bearing
	// type from the current committed doc (seq-guarded).
	let result: ApplyBlueprintChangeResult;
	let deduped: boolean;
	try {
		({ result, deduped } = await persistBlueprint(args, preauthorized));
	} catch (commitErr) {
		await compensate(args.appId, store, migrationEntries);
		throw commitErr;
	}

	// Phase 3: post-commit sweep. Sync every case type the classify entries
	// name against the COMMITTED doc at the committed seq — this covers a
	// peer's concurrently-committed property (via the monotone `synced_seq`
	// merge) AND advances a migration-bearing type's `synced_seq` (its per-row
	// work already ran in Phase 1). Skipped on ANY dedup: a deduped commit
	// pairs the batch's ORIGINAL `seq` with the CURRENT (peer-advanced) doc,
	// and it already swept at that original commit — sweeping the newer schema
	// at the stale seq would let a later stale-seq sweep pass the monotone gate
	// and clobber a peer's property. (`committedDoc` is also absent on a
	// top-level dedup, so the guard covers both dedup shapes.)
	if (!deduped) {
		await sweepCommittedSchemas(store, args.appId, result, entries);
	}
	return result;
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
 * omits it. Returns the public result PLUS `deduped` — the post-commit sweep
 * gates on it, because an IN-transaction dedup pairs the batch's ORIGINAL
 * `seq` with the CURRENT (peer-advanced) doc, an inconsistent pair the sweep
 * must not sync from (it already swept at the original commit).
 *
 * `preauthorized` (the migration path only) forwards the `projectId` the saga
 * already resolved + reauthed so `commitGuardedBatch` skips the redundant
 * second resolve + role check for the same actor.
 */
async function persistBlueprint(
	args: ApplyBlueprintChangeArgs,
	preauthorized?: { projectId: string | null },
): Promise<{ result: ApplyBlueprintChangeResult; deduped: boolean }> {
	if (args.guard === undefined) {
		throw new Error("[applyBlueprintChange] a persist requires a `guard`");
	}
	const { mutations, mediaExpectations } = args.guard;
	const commit = await commitGuardedBatch({
		appId: args.appId,
		batchId: args.batchId,
		...(args.runId !== undefined && { runId: args.runId }),
		mutations,
		actorUserId: args.userId,
		kind: args.kind,
		...(mediaExpectations !== undefined && { mediaExpectations }),
		...(preauthorized !== undefined && { preauthorized }),
	});
	return {
		result: {
			basisToken: commit.basisToken,
			seq: commit.seq,
			committedDoc: commit.committedDoc,
		},
		deduped: commit.deduped,
	};
}

/**
 * Post-commit additive sweep — sync the touched case types against the
 * COMMITTED doc at the committed seq.
 *
 * Runs after `commitGuardedBatch`, so it syncs the schema Firestore actually
 * holds (never the prior-derived prospective, which a concurrent writer can
 * make trail). Scoped to the case types `classifyCaseTypeChanges` named — a
 * non-case-type commit already took the `entries.length === 0` fast path and
 * never reaches here. `syncedSeq = result.seq` feeds the monotone
 * `synced_seq` guard: a peer's concurrently-committed property survives the
 * merge, and a stale lower-seq sync of the same type fully no-ops.
 *
 * Additive-only — no per-row migration. It re-derives EVERY touched type,
 * including a migration-bearing one: Phase 1 synced that type from the
 * PROSPECTIVE (pre-commit, un-versioned), so the sweep is what advances its
 * `synced_seq` AND picks up a property a peer concurrently added to the same
 * type. That means a migration type pays one redundant `readLiveIndexSet`
 * catalog read here even when its own index set is unchanged — accepted: the
 * Phase-B diff emits ZERO `CREATE/DROP INDEX` when the set matches, so it's a
 * single indexed catalog query, and skipping it would risk missing a peer's
 * concurrent additive index.
 *
 * The caller gates this on `!deduped` (a deduped commit already swept at its
 * original commit, and its `(seq, doc)` pair is inconsistent). Each per-type
 * sync is a SINGLE attempt then a swallow — deliberately NO retry: this runs on
 * the already-committed auto-save PUT / MCP response thread, so a sustained blip
 * across N types must not block the user-facing response by up to N×backoff.
 * The swallow is never rethrown (the commit already landed) but splits severity
 * like the build materialize: a transient blip is `warn` (self-heals via the
 * point-of-use `withSchemaHeal`), a deterministic fault is `error` (a real bug
 * worth Sentry — unreachable today). The retry lives only on the non-user-facing
 * drain-end `materializeCaseStoreSchemas`, where a stale schema is hit
 * immediately by a post-build sample-data action.
 */
async function sweepCommittedSchemas(
	store: SchemaCaseStore,
	appId: string,
	result: ApplyBlueprintChangeResult,
	entries: readonly CaseTypeChangeEntry[],
): Promise<void> {
	if (result.committedDoc === undefined) return;
	const committedSchemas = buildCaseTypeMap(result.committedDoc);
	// One sync per DISTINCT touched case type — the classifier can emit several
	// entries for one type (one property added and one retyped), but the sweep
	// re-derives that type's whole schema once regardless.
	const touched = new Set(entries.map((entry) => entry.caseType));
	for (const caseType of touched) {
		// A type the entries name but the committed doc dropped (a concurrent
		// retire) has no schema to derive — skip rather than throw.
		if (!committedSchemas.has(caseType)) continue;
		try {
			await store.applySchemaChange({
				appId,
				caseType,
				caseTypeSchemas: committedSchemas,
				syncedSeq: result.seq,
			});
		} catch (sweepErr) {
			// Never rethrown — the commit already landed, so a sweep failure is
			// not a 500. But split severity like the build materialize: a
			// DETERMINISTIC fault (an unschemable property — trigger unreachable
			// today, Zod gates names + SHA-256 index names) is a real bug worth
			// surfacing to Sentry (`error`); a transient blip self-heals via the
			// point-of-use `withSchemaHeal`, so it's `warn` only.
			const message = `[applyBlueprintChange] post-commit schema sweep failed for caseType=${caseType}`;
			if (isTransientDbError(sweepErr)) {
				log.warn(message, { appId, seq: result.seq, error: sweepErr });
			} else {
				log.error(message, sweepErr, { appId, seq: result.seq });
			}
		}
	}
}

/**
 * Reconcile Postgres back to the CURRENT committed state after a
 * migration-bearing forward-apply or Firestore commit failed.
 *
 * `compensate` receives EVERY migration-bearing entry the saga tried (the
 * additive ones ride the post-commit sweep, which self-heals rather than
 * compensating) — not just the ones whose `applySchemaChange` fully returned.
 * `applySchemaChange` is two-phase, so an entry whose Phase A committed and
 * whose Phase B then threw would be un-recorded by a "track successes" list,
 * yet its schema DID change; covering every entry closes that gap, and
 * re-syncing a type whose Phase A rolled back is a harmless no-op.
 *
 * Phase 1's un-versioned UPSERT overwrote each affected type's schema with M's
 * (now-uncommitted) prospective. Reverting to M's PRIOR snapshot would be
 * wrong under concurrency: a peer who committed a new property to the same type
 * mid-window (and swept it) would lose that property, because M's prior
 * predates the peer's commit. So instead re-derive from a FRESH `loadApp` — the
 * CURRENT committed doc, which carries the peer's committed property and NOT
 * M's failed change — and apply it seq-guarded at the current `mutation_seq`
 * (the same monotone gate the sweep uses), so no committed property is ever
 * dropped by a failed migration and a still-newer concurrent write isn't
 * clobbered either.
 *
 * Schema-sync-only (no `change`): the per-row migration already ran in Phase 1
 * and is NOT inverted — rows already retyped stay in their new JSONB shape,
 * rows already quarantined stay quarantined. That eventual-consistency is
 * acceptable: the fresh-doc schema mirrors what's stored, and a subsequent
 * successful write re-syncs against the migrated rows. The "apps are always
 * valid" lock holds at the schema-row + index layer.
 *
 * If the fresh `loadApp` returns null (the app was concurrently deleted) there
 * is nothing to reconcile. Per-call try/catch isolation: one compensation
 * failure logs and continues. The saga rethrows the original forward error
 * regardless.
 */
async function compensate(
	appId: string,
	store: SchemaCaseStore,
	entries: readonly CaseTypeChangeEntry[],
): Promise<void> {
	if (entries.length === 0) return;
	// The CURRENT committed state — reflects any concurrent peer's committed
	// additions and excludes M's failed change. `mutation_seq` is the seq that
	// state is at, so the seq-guarded re-sync converges with the monotone gate.
	const current = await loadApp(appId);
	if (current === null) {
		log.error(
			"[applyBlueprintChange] compensation skipped — app document missing",
			undefined,
			{ appId },
		);
		return;
	}
	const currentSchemas = buildCaseTypeMap(current.blueprint);
	const currentSeq = current.mutation_seq;
	// Distinct types only — the classifier can emit several entries per type.
	const touched = new Set(entries.map((entry) => entry.caseType));
	for (const caseType of touched) {
		// A type dropped from the current committed doc (a concurrent retire)
		// has no schema to derive — skip. Otherwise re-sync it seq-guarded so a
		// peer's committed property survives and a stale re-sync no-ops.
		if (!currentSchemas.has(caseType)) continue;
		try {
			await store.applySchemaChange({
				appId,
				caseType,
				caseTypeSchemas: currentSchemas,
				syncedSeq: currentSeq,
			});
		} catch (compensateErr) {
			log.error(
				`[applyBlueprintChange] compensation failed for caseType=${caseType}`,
				compensateErr,
				{ appId },
			);
		}
	}
}
