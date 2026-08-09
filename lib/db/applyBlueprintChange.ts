/**
 * Persist one admitted Blueprint mutation batch and keep its derived case
 * schema current.
 *
 * Ordinary schema changes commit first and run an idempotent, seq-guarded
 * materialization. The explicit, batch-exclusive `renameCaseProperties`
 * command instead puts fresh Blueprint admission, live-row and parked-row
 * collision admission, schema Phase A, exact key movement, Blueprint
 * persistence, and the app-change event in one app-locked Postgres
 * transaction. Concurrent index DDL is the only post-commit phase. There is
 * no inferred rename or second runtime path.
 */

import type {
	CasePropertyRenameReport,
	MigrationReport,
	PreparedCasePropertyRenamePhaseB,
	PreparedCaseTypeSchemaRetirementPhaseB,
	SchemaCaseStore,
	TransactionalSchemaCaseStore,
} from "@/lib/case-store";
import {
	buildCaseTypeMap,
	CasePropertyRenameStorageConflictError,
	SchemaChangePhaseBError,
	withSchemaContext,
} from "@/lib/case-store";
import type { AdmittedMutationBatch } from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc } from "@/lib/domain";
import { log } from "@/lib/logger";
import type { OrganizationRevision } from "@/lib/organization/types";
import {
	type ChatRunHolderCapability,
	type CommitGuardedBatchTransactionHooks,
	commitGuardedBatch,
} from "./apps";
import type { CanonicalCommitSidecar } from "./canonicalCommitSidecars";
import {
	type CaseTypeChangeEntry,
	classifyCaseTypeChanges,
} from "./classifyCaseTypeChanges";
import { BlueprintCommitRejectedError } from "./commitGuard";
import { isTransientDbError } from "./schemaSyncRetry";
import type { ClientAppChangeKind } from "./types";

/**
 * Arguments for `applyBlueprintChange`.
 *
 * `runId` is durable stream attribution (chat and MCP both use it).
 * `chatRunHolder` is the separate exact lease authority only chat supplies.
 * Every path routes the blueprint write through the one guarded commit
 * ({@link commitGuardedBatch}) — the transactional read-evaluate-write below.
 * Explicit case-property rename intent comes only from the batch-exclusive
 * command and composes its storage Phase A through that writer.
 *
 * The guarded writer supplies fresh `freshDoc` / `nextDoc` values under the
 * app lock for every correctness-bearing target, classification, persistence,
 * and derived-storage decision.
 */
export interface ApplyBlueprintChangeArgs {
	readonly appId: string;
	readonly userId: string;
	/** Project captured with the caller's blueprint/scope snapshot. */
	readonly expectedProjectId: string;
	/** Exact organization snapshot used by a success-result projection. */
	readonly expectedOrganizationRevision?: OrganizationRevision;
	/** Durable batch attribution. MCP supplies this without owning a chat lease. */
	readonly runId?: string;
	/** Exact chat holder authority. GenerationContext supplies this; MCP and
	 * browser autosave deliberately omit it. */
	readonly chatRunHolder?: ChatRunHolderCapability;
	/** Client-minted idempotency key for this whole change — pairs with the
	 * `app_changes (app_id, batch_id)` unique latch owned by
	 * {@link commitGuardedBatch}'s app-locked, freshly-authorized transaction. */
	readonly batchId: string;
	/** Which write path is committing — stamped on the durable stream entry. */
	readonly kind: ClientAppChangeKind;
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
		readonly mutations: AdmittedMutationBatch;
	};
	/**
	 * Closed, typed transaction sidecars (`canonicalCommitSidecars.ts`) the
	 * kernel executes beside this commit — the change-set receipt and intent
	 * provenance ride here. Server-owned callers only; a dedup replay skips
	 * them (the original commit ran them).
	 */
	readonly sidecars?: readonly CanonicalCommitSidecar[];
	/** Absolute build-executor deadline. Ordinary canonical writers omit it. */
	readonly deadlineAt?: number;
}

/**
 * Result of `applyBlueprintChange`. `seq` is the `mutation_seq` the batch
 * committed at. `committedDoc` is the hydrated committed doc, including on an
 * authorized in-transaction dedup hit.
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
	readonly committedDoc: BlueprintDoc;
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
 * Persist the batch through the fresh guarded writer. Explicit property
 * renames and case-type retirements fail atomically before commit on any
 * Blueprint or storage conflict. Ordinary active-schema materialization and
 * every concurrent-index completion are post-commit, idempotent derived work.
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
	const explicitRename =
		guard.mutations.length === 1 &&
		guard.mutations[0]?.kind === "renameCaseProperties";
	if (explicitRename) {
		const store = await withSchemaContext();
		let prepared: PreparedCasePropertyRenamePhaseB | undefined;
		const { result, deduped } = await persistBlueprint(args, {
			beforeWrite: async ({ tx, nextDoc, seq, casePropertyRenamePlan }) => {
				if (casePropertyRenamePlan === undefined) {
					throw new Error(
						"[applyBlueprintChange] admitted rename omitted its canonical plan",
					);
				}
				try {
					prepared = await store.applyCasePropertyRenamePhaseA(
						tx as unknown as Parameters<
							typeof store.applyCasePropertyRenamePhaseA
						>[0],
						{
							appId: args.appId,
							desiredSeq: seq,
							caseTypeSchemas: buildCaseTypeMap(nextDoc),
							entries: casePropertyRenamePlan.entries,
						},
					);
				} catch (error) {
					if (error instanceof CasePropertyRenameStorageConflictError) {
						throw new BlueprintCommitRejectedError(
							`Saved ${error.carrier === "case-row" ? "case" : "parked"} data now occupies "${error.property}" on "${error.caseType}". Review the rename conflicts and try again.`,
						);
					}
					throw error;
				}
			},
		});
		if (deduped || prepared === undefined) {
			if (args.deadlineAt !== undefined) return result;
			await drainRenameIndexesBestEffort(store, args.appId, result.seq);
			return result;
		}

		if (args.deadlineAt !== undefined) {
			return { ...result, migration: renameOutcome(prepared.report) };
		}
		await completeRenameIndexes(args.appId, result, prepared);
		return { ...result, migration: renameOutcome(prepared.report) };
	}

	let entries: readonly CaseTypeChangeEntry[] | undefined;
	let store: TransactionalSchemaCaseStore | undefined;
	let preparedRetirement: PreparedCaseTypeSchemaRetirementPhaseB | undefined;
	const { result, deduped } = await persistBlueprint(args, {
		beforeWrite: async ({ tx, freshDoc, nextDoc, seq }) => {
			entries = classifyCaseTypeChanges({
				prior: freshDoc,
				prospective: nextDoc,
			});
			const retired = entries
				.filter((entry) => entry.kind === "retire")
				.map((entry) => entry.caseType);
			if (retired.length > 0) {
				store = await withSchemaContext();
				preparedRetirement = await store.retireSchemasPhaseA(
					tx as unknown as Parameters<typeof store.retireSchemasPhaseA>[0],
					{
						appId: args.appId,
						desiredSeq: seq,
						caseTypes: retired,
						fallbackCaseTypeSchemas: buildCaseTypeMap(freshDoc),
					},
				);
			}
		},
	});
	if (deduped) {
		if (args.deadlineAt !== undefined) return result;
		const explicitlyRetired = guard.mutations.flatMap((mutation) =>
			mutation.kind === "retireCaseType" ? [mutation.caseType] : [],
		);
		if (explicitlyRetired.length > 0) {
			store ??= await withSchemaContext();
			await drainRetirementIndexesBestEffort(
				store,
				args.appId,
				result.seq,
				explicitlyRetired,
			);
		}
		return result;
	}
	if (entries === undefined) {
		throw new Error(
			"[applyBlueprintChange] guarded writer committed without running its fresh classification hook",
		);
	}
	/* Executor-owned commits end at the canonical transaction. Runtime-schema
	 * Phase A is already atomic; every Phase-B/index/sync operation below is
	 * derived, idempotent convergence and must not outlive the slice deadline.
	 * Point-of-use schema healing drains the durable lag. */
	if (args.deadlineAt !== undefined) return result;
	if (entries.length === 0) return result;
	if (preparedRetirement !== undefined) {
		await completeRetirementIndexes(args.appId, result, preparedRetirement);
	}
	const syncEntries = entries.filter((entry) => entry.kind === "sync");
	if (syncEntries.length === 0) return result;
	store ??= await withSchemaContext();
	const reports = await sweepCommittedSchemas(
		store,
		args.appId,
		result,
		syncEntries,
	);
	return {
		...result,
		migration: migrationOutcome(reports),
	};
}

/**
 * Commit the blueprint through the unified guarded writer. Every caller of the
 * boundary supplies a `guard` (the whole-doc non-guard path is gone); the
 * transactional re-apply-on-fresh + re-verdict + concurrent-delete guard +
 * complete-poststate media validation + durable stream + dedup latch +
 * `mutation_seq` advance all live in {@link commitGuardedBatch}. `run_id`
 * (MCP) rides along; auto-save
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
	hooks: CommitGuardedBatchTransactionHooks = {},
): Promise<{ result: ApplyBlueprintChangeResult; deduped: boolean }> {
	if (args.guard === undefined) {
		throw new Error("[applyBlueprintChange] a persist requires a `guard`");
	}
	const { mutations } = args.guard;
	const commit = await commitGuardedBatch(
		{
			appId: args.appId,
			batchId: args.batchId,
			...(args.runId !== undefined && { runId: args.runId }),
			...(args.chatRunHolder !== undefined && {
				chatRunHolder: args.chatRunHolder,
			}),
			mutations,
			actorUserId: args.userId,
			kind: args.kind,
			expectedProjectId: args.expectedProjectId,
			...(args.expectedOrganizationRevision !== undefined && {
				expectedOrganizationRevision: args.expectedOrganizationRevision,
			}),
		},
		{
			...hooks,
			...(args.sidecars !== undefined && { sidecars: args.sidecars }),
			...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
		},
	);
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
	const committedSchemas = buildCaseTypeMap(result.committedDoc);
	// One sync per DISTINCT touched case type — the classifier can emit several
	// entries for one type (one property added and one retyped), but the sweep
	// re-derives that type's whole schema once regardless.
	const touched = new Set(
		entries
			.filter((entry) => entry.kind === "sync")
			.map((entry) => entry.caseType),
	);
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

function migrationOutcome(
	reports: readonly AttributedReport[],
): MigrationOutcome {
	return {
		migrated: reports.reduce((sum, item) => sum + item.report.migrated, 0),
		reshaped: reports.reduce((sum, item) => sum + item.report.reshaped, 0),
		retyped: reports.reduce((sum, item) => sum + item.report.retyped, 0),
		restored: reports.reduce((sum, item) => sum + item.report.restored, 0),
		parked: reports.reduce(
			(sum, item) => sum + item.report.parkedIds.length,
			0,
		),
		parkedCaseTypes: [
			...new Set(
				reports
					.filter((item) => item.report.parkedIds.length > 0)
					.map((item) => item.caseType),
			),
		],
		failureReasons: reports.flatMap((item) => item.report.failureReasons),
	};
}

function renameOutcome(report: CasePropertyRenameReport): MigrationOutcome {
	return {
		migrated: report.renamedRows,
		reshaped: 0,
		retyped: 0,
		restored: 0,
		parked: 0,
		parkedCaseTypes: [],
		failureReasons: [],
	};
}

async function completeRenameIndexes(
	appId: string,
	result: ApplyBlueprintChangeResult,
	prepared: PreparedCasePropertyRenamePhaseB,
): Promise<void> {
	try {
		await prepared.completeAfterCommit();
	} catch (error) {
		const message =
			"[applyBlueprintChange] post-commit rename index completion failed";
		if (isTransientDbError(error)) {
			log.warn(message, { appId, seq: result.seq, error });
		} else {
			log.error(message, error, { appId, seq: result.seq });
		}
	}
}

async function completeRetirementIndexes(
	appId: string,
	result: ApplyBlueprintChangeResult,
	prepared: PreparedCaseTypeSchemaRetirementPhaseB,
): Promise<void> {
	try {
		await prepared.completeAfterCommit();
	} catch (error) {
		const message =
			"[applyBlueprintChange] post-commit case-type retirement index completion failed";
		if (isTransientDbError(error)) {
			log.warn(message, { appId, seq: result.seq, error });
		} else {
			log.error(message, error, { appId, seq: result.seq });
		}
	}
}

async function drainRetirementIndexesBestEffort(
	store: TransactionalSchemaCaseStore,
	appId: string,
	seq: number,
	caseTypes: readonly string[],
): Promise<void> {
	try {
		await store.drainRetiredIndexConvergence({ appId, caseTypes });
	} catch (error) {
		const message =
			"[applyBlueprintChange] pending case-type retirement index convergence failed";
		if (isTransientDbError(error)) {
			log.warn(message, { appId, seq, error });
		} else {
			log.error(message, error, { appId, seq });
		}
	}
}

async function drainRenameIndexesBestEffort(
	store: Awaited<ReturnType<typeof withSchemaContext>>,
	appId: string,
	seq: number,
): Promise<void> {
	try {
		await store.drainPendingIndexConvergence({ appId });
	} catch (error) {
		const message =
			"[applyBlueprintChange] pending rename index convergence failed";
		if (isTransientDbError(error)) {
			log.warn(message, { appId, seq, error });
		} else {
			log.error(message, error, { appId, seq });
		}
	}
}
