/**
 * Cross-store saga for blueprint writes — orchestrates the app-state store
 * (the blueprint) and the case-store (schema + row population) so the two
 * never drift under concurrency.
 *
 * ## The two-arm sync
 *
 * Concurrent additive case-type edits must both materialize
 * without either losing a per-row migration. The sync splits
 * `classifyCaseTypeChanges`'s entries by change kind:
 *
 *   - **Migration-bearing** entries (a `change` shape — a
 *     classifier-proven rename, single-actor by nature):
 *     run Postgres-first + `compensate()` BEFORE the commit,
 *     derived from the guarded mutation projection. The per-row migration
 *     is recoverable — a failure inverts the rename's row moves
 *     and re-syncs from the CURRENT committed doc (a fresh
 *     `loadApp`), seq-guarded, so it restores the schema row +
 *     index DDL + row keys without dropping a concurrent peer's
 *     committed property. The commit itself holds the last gate:
 *     `renameExpectations` makes it re-prove the batch's renames
 *     against the FRESH doc pair and reject when its trailing
 *     prior migrated a different pair than the re-apply commits.
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
 * The additive sweep carries no caller-intent migration and
 * nothing to compensate (the store's own string↔array reshape may
 * still rewrite rows inside the sync — see `applySchemaChange`). A
 * sweep failure logs at `warn` and returns success — it is
 * idempotent and re-derivable via the next save / the point-of-use
 * heal.
 *
 * ## Saga shape
 *
 *   1. Compute the prospective new blueprint state in memory.
 *   2. Diff prior vs. prospective via `classifyCaseTypeChanges` and
 *      partition into migration-bearing vs. additive entries.
 *   3. If there ARE migration-bearing entries, hold the app row plus fresh
 *      Project edit authorization and, for chat, exact run-holder authority
 *      while every entry's schema/data Phase A runs in that same transaction
 *      and connection. This blocks membership DML, Project moves, and holder
 *      replacement for the entire side effect. A pure additive /
 *      non-case-type commit runs no pre-commit DDL and relies on
 *      `commitGuardedBatch` alone.
 *   4. Run the MIGRATION-BEARING entries Postgres-first against the
 *      prospective; a mid-loop failure compensates the already-applied
 *      ones and rethrows.
 *   5. Commit the new blueprint (`commitGuardedBatch`). On failure,
 *      compensate every migration-bearing entry from the current
 *      committed doc (seq-guarded) and rethrow.
 *   6. Unless the commit deduped, sweep every touched case type
 *      against the committed doc at the committed seq (post-commit,
 *      swallow + warn).
 *
 * The saga is a no-op fast path for purely non-case-type
 * mutations (module name edits, form text edits, field UI
 * tweaks): `classifyCaseTypeChanges` returns an empty array and
 * the saga skips the case-store entirely, committing the blueprint directly.
 *
 * ## Where the saga is wired in
 *
 * The two awaited blueprint-write boundaries:
 *   - `app/api/apps/[id]/route.ts` PUT (auto-save).
 *   - `lib/mcp/context.ts` `recordMutations` (MCP tool calls).
 *
 * The chat surface routes only its RENAME-capable batches here
 * (`GenerationContext.commitBatch` detects `renameField` and
 * `moveField` — the latter's cross-parent dedup can rename): a rename's
 * row migration must run while the snapshots still prove it — once the
 * batch commits bare, both sides of every later diff hold the new name
 * and the drain-end additive materialize would strand the rows. Every
 * other chat batch commits inline through `commitGuardedBatch` directly
 * (awaited), and the chat route's drain-end finalize re-syncs the
 * case-store schemas in one pass for whatever the run persisted — so
 * the common chat path needs no per-save saga.
 *
 * ## Loading the prior state
 *
 * Callers that already loaded the app document (the auto-save
 * PUT route does so for its ownership check) pass the prior
 * blueprint via `args.priorBlueprint` — the saga uses it
 * directly, no second app-state read. Callers without a
 * pre-loaded snapshot (the MCP path's `McpContext.saveBlueprint`)
 * omit the field, and the saga loads the doc itself. The auto-
 * save PUT path costs one app-state read end-to-end (the
 * ownership-check load that's then threaded through); the MCP
 * path costs the saga's internal load.
 */

import { produce } from "immer";
import type { MigrationReport, SchemaCaseStore } from "@/lib/case-store";
import {
	buildCaseTypeMap,
	SchemaChangePhaseBError,
	withSchemaContext,
} from "@/lib/case-store";
import { assertPersistenceSafeMutationIdentities } from "@/lib/doc/commitVerdicts";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	PersistableDoc,
	PersistedBlueprint,
} from "@/lib/domain";
import { log } from "@/lib/logger";
import type { MediaAttachExpectation } from "@/lib/media/attachVerdicts";
import {
	type ChatRunHolderCapability,
	commitGuardedBatch,
	loadApp,
	withAuthorizedAppEditSideEffect,
} from "./apps";
import {
	type CaseTypeChangeEntry,
	classifyCaseTypeChanges,
	type RenameExpectation,
} from "./classifyCaseTypeChanges";
import { BlueprintCommitRejectedError } from "./commitGuard";
import { getAppDb } from "./pg";
import { isTransientDbError } from "./schemaSyncRetry";
import type { AcceptedMutationDoc } from "./types";

/**
 * Arguments for `applyBlueprintChange`.
 *
 * `runId` is durable stream attribution (chat and MCP both use it).
 * `chatRunHolder` is the separate exact lease authority only chat supplies.
 * Every path routes the blueprint write through the one guarded commit
 * ({@link commitGuardedBatch}) — the transactional read-evaluate-write below —
 * after the case-store schema saga.
 *
 * Per-row migration intent is NOT a caller input: the classifier
 * proves renames itself from the two snapshots (field-uuid
 * evidence — see `classifyCaseTypeChanges`) and emits the matching
 * `change` entry, so the schema sync + per-row migration run in
 * one Postgres transaction with no caller threading a hint.
 *
 * `priorBlueprint` lets a caller that already loaded the app
 * document (the auto-save PUT route does so for ownership) skip
 * the saga's internal `loadApp` round trip. Absent: the saga
 * loads the prior blueprint itself. Supplying it on every awaited
 * blueprint write that already paid the load cost halves the
 * app-state-read budget on hot edit paths.
 */
export interface ApplyBlueprintChangeArgs {
	readonly appId: string;
	readonly userId: string;
	/** Project captured with the caller's blueprint/scope snapshot. */
	readonly expectedProjectId: string | null;
	/**
	 * Advisory whole-doc projection retained for callers that already computed
	 * one. It never drives schema work or persistence: the saga derives its own
	 * prospective by replaying the deterministic `guard.mutations` on `prior`.
	 */
	readonly prospective?: PersistedBlueprint;
	/** Durable batch attribution. MCP supplies this without owning a chat lease. */
	readonly runId?: string;
	/** Exact chat holder authority. GenerationContext supplies this; MCP and
	 * browser autosave deliberately omit it. */
	readonly chatRunHolder?: ChatRunHolderCapability;
	/** Client-minted idempotency key for this whole change — pairs with the
	 *  `accepted_mutations (app_id, batch_id)` unique latch. A top-level dedup
	 *  hit short-circuits the case-store saga; {@link commitGuardedBatch}'s
	 *  in-txn latch is the durable guard. */
	readonly batchId: string;
	/** Which write path is committing — stamped on the durable stream entry. */
	readonly kind: AcceptedMutationDoc["kind"];
	readonly priorBlueprint?: PersistableDoc;
	/**
	 * Guarded MUTATION commit: the blueprint write is a transactional
	 * read-evaluate-write — re-apply `mutations` onto the FRESH stored
	 * blueprint and re-run the validity verdict before writing. A
	 * concurrent committed batch can't be erased (the recomputed doc
	 * builds ON the fresh state — the non-destructive merge), and a batch
	 * the fresh verdict rejects throws `BlueprintCommitRejectedError`
	 * with nothing written. With `runId` it routes through the run-scoped
	 * writer (MCP tool calls); without one, through the tokenless
	 * auto-save writer that rotates + returns the basis token.
	 */
	readonly guard: {
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
 * Result of `applyBlueprintChange`. `seq` is the `mutation_seq` the batch
 * committed at. `committedDoc` is the hydrated committed doc — absent only on
 * a TOP-LEVEL dedup hit (which returns the recorded seq without paying the
 * app-doc read; the in-txn dedup inside {@link commitGuardedBatch} does
 * supply it).
 */
/**
 * What the commit's row migrations did to the saved case data —
 * aggregated over the Phase-1 forward applies AND the post-commit
 * sweep (whose write-time detection can retype/park on its own).
 * `parked` counts VALUES set aside into `parked_case_values`;
 * `failureReasons` is their person-readable why. Absent when the
 * commit touched no case-type schema (the fast path) or deduped.
 * The PUT route surfaces it so the builder can toast the outcome
 * instead of silently discarding it.
 */
export interface MigrationOutcome {
	readonly migrated: number;
	readonly reshaped: number;
	readonly retyped: number;
	readonly restored: number;
	readonly parked: number;
	/**
	 * The case types whose syncs set values aside this commit — the
	 * client's discovery signal (which module's Case data to point the
	 * toast at, which per-type caches to refresh). Empty when nothing
	 * parked.
	 */
	readonly parkedCaseTypes: readonly string[];
	readonly failureReasons: readonly string[];
}

export interface ApplyBlueprintChangeResult {
	readonly seq: number;
	readonly committedDoc?: BlueprintDoc;
	readonly migration?: MigrationOutcome;
}

/**
 * A sync's report paired with the case type it ran against —
 * `MigrationReport` itself carries no type, and the outcome's
 * `parkedCaseTypes` needs the attribution.
 */
interface AttributedReport {
	readonly caseType: string;
	readonly report: MigrationReport;
}

/**
 * Run the cross-store saga and persist the prospective blueprint.
 *
 * Throws on any unrecoverable failure of the migration-bearing arm
 * (its case-store schema sync failing with no recovery, or a
 * blueprint commit failure after its compensation completed). On
 * either, the migration-bearing Postgres work is compensated back
 * to the prior state and the original error rethrows — the caller
 * can retry without half-applied writes. The additive post-commit
 * sweep never throws (swallow + warn); an additive gap self-heals
 * on the next save.
 */
export async function applyBlueprintChange(
	args: ApplyBlueprintChangeArgs,
): Promise<ApplyBlueprintChangeResult> {
	const guard = args.guard;
	if (guard === undefined) {
		throw new Error("[applyBlueprintChange] a persist requires a `guard`");
	}
	if (
		(args.kind === "chat" &&
			(args.chatRunHolder?.source !== "chat" ||
				args.runId === undefined ||
				args.runId !== args.chatRunHolder?.runId)) ||
		(args.kind !== "chat" && args.chatRunHolder !== undefined)
	) {
		throw new Error(
			"[applyBlueprintChange] chat writes require matching chat holder authority; non-chat writes cannot supply it",
		);
	}
	// Top-level idempotency: a re-delivered batch (a client retry) whose latch
	// already exists short-circuits the whole cross-store saga. The read is
	// non-transactional — a batch that commits between here and the guarded
	// write is still caught by `commitGuardedBatch`'s in-transaction latch. A
	// hit returns the recorded seq with no `committedDoc` (skips the
	// app-doc read); MCP/auto-save tolerate its absence on a dedup hit.
	const db = await getAppDb();
	const latch = await db
		.selectFrom("accepted_mutations")
		.select("seq")
		.where("app_id", "=", args.appId)
		.where("batch_id", "=", args.batchId)
		.executeTakeFirst();
	if (latch) {
		return { seq: Number(latch.seq) };
	}
	// Admission applies only to a new batch. An existing latch is authoritative
	// history and must remain replay-idempotent even if today's admission rules
	// would reject its original payload.
	try {
		assertPersistenceSafeMutationIdentities(guard.mutations);
	} catch (error) {
		throw new BlueprintCommitRejectedError(
			error instanceof Error
				? error.message
				: "This mutation batch cannot be persisted deterministically.",
		);
	}

	const priorBlueprint = await resolvePriorBlueprint(args);
	/* Derive the saga's prospective exclusively from the deterministic mutation
	 * batch. A caller-supplied whole document is advisory and cannot cause
	 * pre-commit schema work for state the authoritative commit would never
	 * produce. The guarded commit re-applies on the FRESH doc, so a concurrent
	 * writer can make this prior-based derivation momentarily trail; only
	 * `caseTypes` is read from
	 * it (for the Postgres diff), and the next save re-syncs — the same
	 * eventual consistency the per-row migrations already document. */
	const prospectiveBlueprint: BlueprintDoc = produce(
		priorBlueprint,
		(draft) => {
			applyMutations(draft, guard.mutations);
		},
	);

	const entries = classifyCaseTypeChanges({
		prior: priorBlueprint,
		prospective: prospectiveBlueprint,
	});

	// Fast path — pure non-case-type mutation, skip the case-store entirely and
	// commit the blueprint directly. `commitGuardedBatch`'s own reauth is the
	// single gate here (no pre-commit DDL to protect). The empty
	// rename-expectation list still arms the commit's rename gate: a batch
	// classified as rename-free against a TRAILING prior can re-apply as a
	// rename against the fresh doc, and committing that bare would strand
	// rows with the evidence expired.
	if (entries.length === 0) {
		return (await persistBlueprint(args, [])).result;
	}

	// Tenant-free schema store: the saga only ever calls
	// `applySchemaChange` / `dropSchema`, both app-scoped, so it binds no
	// Project. (The media-expectation re-check inside the commit
	// transaction below scopes to the fresh app doc's `project_id`.)
	const store = await withSchemaContext();

	// The migration-bearing entries run Postgres-first + compensate; the
	// additive ones ride the post-commit sweep. `change !== undefined` is the
	// discriminator the classifier stamps for a proven per-row reshape. A
	// change entry's case type is always present in the prospective — the
	// classifier synthesizes it FROM the prospective's materializable view,
	// the same view `buildCaseTypeMap` builds — so no absent-type filter is
	// needed before Phase 1.
	const prospectiveSchemas = buildCaseTypeMap(prospectiveBlueprint);
	const migrationEntries = entries
		.filter((entry) => entry.change !== undefined)
		.toSorted(
			(a, b) =>
				a.caseType.localeCompare(b.caseType) ||
				(a.property ?? "").localeCompare(b.property ?? ""),
		);

	// Every rename pair the classifier proved, flattened for the guarded
	// commit's rename-expectation gate: inside the commit transaction the
	// gate RE-proves the pairs against the FRESH doc pair and rejects when
	// the fresh evidence names a pair Phase 1 did not migrate — the
	// trailing-prior race where a concurrent commit changed what this
	// batch's re-apply renames. Passed even when EMPTY (the fresh re-apply
	// of a batch classified as rename-free can still produce a rename
	// against a doc that moved under it).
	const renameExpectations: RenameExpectation[] = migrationEntries.flatMap(
		(entry) =>
			entry.change?.kind === "rename"
				? entry.change.renames.map((pair) => ({
						caseType: entry.caseType,
						from: pair.from,
						to: pair.to,
					}))
				: [],
	);

	// Phase 1: forward-apply each MIGRATION-BEARING change against Postgres,
	// derived from the deterministic guarded mutation projection. The additive
	// entries are NOT applied here — they wait for the post-commit sweep of the
	// committed doc.
	//
	// All migration entries' Phase A work shares the app/membership transaction;
	// it either commits as a unit or rolls back as a unit. Only after that commit
	// do their concurrent-index Phase B completions run without an old snapshot
	// or a second connection pinned behind the app lock.
	// Every report the saga's schema syncs produce, aggregated into the
	// result's `migration` outcome; the parked ids additionally feed the
	// compensation path — a failed commit un-parks what its forward
	// applies set aside, restoring the values under the restored schema.
	const forwardReports: AttributedReport[] = [];
	const forwardParkedIds = (): string[] =>
		forwardReports.flatMap(({ report }) => report.parkedIds);
	try {
		if (migrationEntries.length > 0) {
			const admitted = await withAuthorizedAppEditSideEffect(
				args.appId,
				args.userId,
				args.expectedProjectId,
				args.chatRunHolder,
				async (tx) => {
					const phases: Array<{
						caseType: string;
						phaseA: Awaited<ReturnType<typeof store.applySchemaChangePhaseA>>;
					}> = [];
					for (const entry of migrationEntries) {
						phases.push({
							caseType: entry.caseType,
							phaseA: await store.applySchemaChangePhaseA(tx, {
								appId: args.appId,
								caseType: entry.caseType,
								caseTypeSchemas: prospectiveSchemas,
								...(entry.property !== undefined && {
									property: entry.property,
								}),
								...(entry.change !== undefined && { change: entry.change }),
							}),
						});
					}
					return phases;
				},
			);
			// Every Phase A is now durable, so record every report before any Phase B
			// can throw; compensation needs all parked ids, including a later entry
			// whose index completion was never reached.
			forwardReports.push(
				...admitted.value.map(({ caseType, phaseA }) => ({
					caseType,
					report: phaseA.report,
				})),
			);
			for (const { phaseA } of admitted.value) {
				await phaseA.completeAfterCommit();
			}
		}
	} catch (forwardErr) {
		// Admission denial and any Phase-A/outer-COMMIT failure left the shared
		// transaction rolled back, so there is nothing to compensate. Reports are
		// populated only after that transaction successfully commits.
		if (forwardReports.length > 0) {
			await compensate(args.appId, store, migrationEntries, forwardParkedIds());
		}
		throw forwardErr;
	}

	// Phase 2: commit the blueprint. On failure, compensate every
	// migration-bearing type from the current committed doc (seq-guarded).
	let result: ApplyBlueprintChangeResult;
	let deduped: boolean;
	try {
		({ result, deduped } = await persistBlueprint(args, renameExpectations));
	} catch (commitErr) {
		await compensate(args.appId, store, migrationEntries, forwardParkedIds());
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
		const sweepReports = await sweepCommittedSchemas(
			store,
			args.appId,
			result,
			entries,
		);
		const all = [...forwardReports, ...sweepReports];
		return {
			...result,
			migration: {
				migrated: all.reduce((sum, r) => sum + r.report.migrated, 0),
				reshaped: all.reduce((sum, r) => sum + r.report.reshaped, 0),
				retyped: all.reduce((sum, r) => sum + r.report.retyped, 0),
				restored: all.reduce((sum, r) => sum + r.report.restored, 0),
				parked: all.reduce((sum, r) => sum + r.report.parkedIds.length, 0),
				parkedCaseTypes: [
					...new Set(
						all
							.filter((r) => r.report.parkedIds.length > 0)
							.map((r) => r.caseType),
					),
				],
				failureReasons: all.flatMap((r) => r.report.failureReasons),
			},
		};
	}
	return result;
}

/**
 * Resolve the prior blueprint snapshot the diff runs against.
 * When the caller supplies `priorBlueprint` (the auto-save PUT
 * route already loaded the doc for the ownership check), use it
 * directly — saves an app-state round trip on every save. Without
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
 * The caller's `expectedProjectId` detects a move since its source snapshot;
 * it never skips the commit's own fresh transactional authorization.
 */
async function persistBlueprint(
	args: ApplyBlueprintChangeArgs,
	renameExpectations: readonly RenameExpectation[],
): Promise<{ result: ApplyBlueprintChangeResult; deduped: boolean }> {
	if (args.guard === undefined) {
		throw new Error("[applyBlueprintChange] a persist requires a `guard`");
	}
	const { mutations, mediaExpectations } = args.guard;
	const commit = await commitGuardedBatch({
		appId: args.appId,
		batchId: args.batchId,
		...(args.runId !== undefined && { runId: args.runId }),
		...(args.chatRunHolder !== undefined && {
			chatRunHolder: args.chatRunHolder,
		}),
		mutations,
		actorUserId: args.userId,
		kind: args.kind,
		renameExpectations,
		expectedProjectId: args.expectedProjectId,
		...(mediaExpectations !== undefined && { mediaExpectations }),
	});
	return {
		result: {
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
 * Runs after `commitGuardedBatch`, so it syncs the schema the committed doc
 * actually holds (never the prior-derived prospective, which a concurrent writer can
 * make trail). Scoped to the case types `classifyCaseTypeChanges` named — a
 * non-case-type commit already took the `entries.length === 0` fast path and
 * never reaches here. `syncedSeq = result.seq` feeds the monotone
 * `synced_seq` guard: a peer's concurrently-committed property survives the
 * merge, and a stale lower-seq sync of the same type fully no-ops.
 *
 * No caller-intent migration rides this sweep (the store's own
 * string↔array reshape may still rewrite flipped rows inside the
 * sync). It re-derives EVERY touched type,
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
): Promise<AttributedReport[]> {
	const reports: AttributedReport[] = [];
	if (result.committedDoc === undefined) return reports;
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
			reports.push({
				caseType,
				report: await store.applySchemaChange({
					appId,
					caseType,
					caseTypeSchemas: committedSchemas,
					syncedSeq: result.seq,
				}),
			});
		} catch (sweepErr) {
			// A Phase-B failure committed its Phase A (possibly parking
			// values) — keep its report so the aggregated outcome still
			// surfaces the parks to the user.
			if (sweepErr instanceof SchemaChangePhaseBError) {
				reports.push({ caseType, report: sweepErr.report });
			}
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
	return reports;
}

/**
 * Reconcile the case-store back to the CURRENT committed state after a
 * migration-bearing forward-apply or blueprint commit failed.
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
 * A rename entry's Phase-1 per-row migration IS inverted — before the type's
 * re-sync, the pairs run through `applySchemaChange` again with from/to
 * swapped, so values return to the keys the restored schema declares (this
 * includes a value a concurrent writer legitimately landed under the
 * prospective schema mid-window: it travels back with the inversion instead
 * of becoming an orphan the merged-update strip would shed). Only PLAIN
 * renames invert: a pair whose forward destination is still declared in the
 * current committed doc was a MERGE-rename, and moving ALL of the merged
 * key's values back would relocate the destination's own pre-merge data —
 * so merge pairs are skipped, leaving the moved values valid and visible
 * under the (still-declared) destination. A pair whose old name the current
 * doc no longer declares is likewise skipped (nothing valid to restore to).
 * The inversion is simultaneous like the forward pass, so chains reverse
 * correctly; dropped uncastable/blank values are gone either way (reported
 * in the forward call's `failureReasons`).
 *
 * KNOWN LIMITATION (fidelity, not validity): the re-sync's reverse
 * casts are not byte-faithful for every forward transition — a
 * multi→single flip's space-join lifts back as ONE element, and a
 * canonicalized temporal value (a midnight extension) stays extended
 * because the reverse direction is an identity widening. Every value
 * remains VALID under the restored schema; a failed commit can leave
 * it in the canonicalized form rather than the original bytes.
 * Byte-faithful compensation needs pre-migration value capture on the
 * forward applies — tracked as follow-up work on the #252 arc.
 *
 * Values the forward applies PARKED un-park LAST (`parkedIds`), after every
 * type's re-sync has restored the schema state they were valid under — the
 * ordering `unparkValues` contracts on. This covers the rename arm's
 * conflict/uncastable parks AND anything the forward sync's write-time
 * retype detection set aside; an entry whose key meanwhile holds a real
 * concurrent value is kept parked (lossless) rather than clobbered. Rows a
 * retype already CAST stay in their new JSONB shape only until the re-sync's
 * own detection casts them back where a faithful cast exists; the fresh-doc
 * schema mirrors what's stored either way.
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
	parkedIds: readonly string[],
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
	// The forward rename pairs per type — inverted below so row values
	// return to the keys the restored schema declares.
	const renamesByType = new Map<
		string,
		ReadonlyArray<{ from: string; to: string }>
	>();
	for (const entry of entries) {
		if (entry.change?.kind === "rename") {
			renamesByType.set(entry.caseType, entry.change.renames);
		}
	}
	// Distinct types only — the classifier can emit several entries per type.
	const touched = new Set(entries.map((entry) => entry.caseType));
	for (const caseType of touched) {
		// A type dropped from the current committed doc (a concurrent retire)
		// has no schema to derive — skip. Otherwise re-sync it seq-guarded so a
		// peer's committed property survives and a stale re-sync no-ops.
		const currentType = currentSchemas.get(caseType);
		if (currentType === undefined) continue;
		const forward = renamesByType.get(caseType);
		if (forward !== undefined) {
			const currentProps = new Set(
				currentType.properties.map((prop) => prop.name),
			);
			// Invert only PLAIN renames — see the docblock's merge-pair rule.
			const inverse = forward
				.filter(
					(pair) => currentProps.has(pair.from) && !currentProps.has(pair.to),
				)
				.map((pair) => ({ from: pair.to, to: pair.from }));
			if (inverse.length > 0) {
				try {
					await store.applySchemaChange({
						appId,
						caseType,
						caseTypeSchemas: currentSchemas,
						change: { kind: "rename", renames: inverse },
					});
				} catch (invertErr) {
					log.error(
						`[applyBlueprintChange] rename inversion failed for caseType=${caseType}`,
						invertErr,
						{ appId },
					);
				}
			}
		}
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
	// Un-park LAST — every touched type's schema is back at the current
	// committed state above, so each restored value lands under a
	// declaration it was valid for (the `unparkValues` caller contract).
	if (parkedIds.length > 0) {
		try {
			await store.unparkValues({ appId, ids: parkedIds });
		} catch (unparkErr) {
			log.error(
				"[applyBlueprintChange] un-park failed during compensation — the values remain recoverable in parked_case_values",
				unparkErr,
				{ appId, parkedCount: parkedIds.length },
			);
		}
	}
}
