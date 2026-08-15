/**
 * App CRUD + the run lifecycle, on Postgres row locks.
 *
 * An app is its `apps` row (scalars, denormalized list fields, the run lease
 * + credit-reservation marker as nullable column groups) plus its
 * `blueprint_entities` rows; every read assembles the blueprint through
 * `lib/db/blueprintRows.ts` and every commit writes only the entity rows the
 * batch actually changed. The app ROW is the serialization point: every
 * transaction that decides anything about a run locks it first
 * (`SELECT … FOR UPDATE`), so per-app contention resolves as row-lock waits
 * and every decision reads the row's fresh state inside its own locking
 * transaction.
 *
 * **Claim and reserve are ONE transaction** (`claimAndReserveRun`): the busy
 * check, the cross-app concurrency guard, the leftover-marker refund, the
 * credit debit, and the claim writes commit together or not at all. A
 * claimed-but-unreserved app is unrepresentable, which deletes the
 * window that once forced a claim-restore dance and the displaced-marker
 * special cases; a rejected claim (busy / out of credits / concurrency) is a
 * rollback that held nothing.
 */

import Fuse from "fuse.js";
import {
	type ExpressionBuilder,
	type RawBuilder,
	type Selectable,
	sql,
	type Transaction,
	type UpdateResult,
} from "kysely";
import type { ErrorType } from "@/lib/agent";
import { getAuthDb } from "@/lib/auth/db";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { retenantAppCasesOn } from "@/lib/case-store/retenant";
import type { Database as CaseDatabase } from "@/lib/case-store/sql/database";
import {
	collectThreadAttachmentAssetIds,
	collectThreadAttachments,
	remapThreadAttachmentAssetIds,
} from "@/lib/chat/threadAttachments";
import { isBuiltinIconRef } from "@/lib/domain/builtinIcons";
import { log } from "@/lib/logger";
import { applyOrganizationCommitIntegrity } from "@/lib/organization/commitIntegrity";
import {
	nextPersistedSequence,
	safePersistedSequence,
} from "@/lib/utils/persistedSequence";
import {
	describeCommitFindings,
	evaluatePreparedMutationCandidate,
	prepareMutationCandidate,
} from "../doc/commitVerdicts";
import { deepEqual } from "../doc/deepEqual";
import {
	CasePropertySemanticProvenanceRequiredError,
	diffDocsToMutations,
} from "../doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "../doc/fieldParent";
import {
	EMPTY_LOOKUP_REFERENCE_TARGETS,
	extractLookupReferenceTargets,
	unionLookupReferenceTargetSets,
} from "../doc/lookupReferences";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
	encodeAdmittedMutationEnvelope,
} from "../doc/mutationAdmission";
import type { Mutation } from "../doc/types";
import type {
	BlueprintDoc,
	PersistableDoc,
	PersistedBlueprint,
} from "../domain/blueprint";
import {
	asWalkableDoc,
	collectRealAssetRefs,
	remapAssetRefs,
} from "../domain/mediaRefs";
import {
	type AssetKind,
	asMediaAssetId,
	type MediaAssetId,
} from "../domain/multimedia";
import {
	lockActorGenerationGate,
	lockActorGenerationGateForAppHolder,
	type ReapableGenerationTarget,
	scanActorGenerationTargets,
} from "./actorGenerationGate";
import {
	admitExactMediaReferences,
	assertAppCapabilityInTransaction,
	assertExpectedAppProject,
	assertProjectCapabilityInTransaction,
	blueprintMediaRequirements,
	type CanonicalCommitKernelOptions,
	type CanonicalCommitReceipt,
	type CanonicalCommitRequest,
	type CanonicalCommitTransactionHooks,
	type ChatRunHolderCapability,
	commitCanonicalBatch,
	denormalize,
	hasLookupReferenceTargets,
	loadAppInTransaction,
	loadSchemaAdmittedAppSnapshotFromRowInTransaction,
	loadStrictAppSnapshotFromRowInTransaction,
	lockAppRow,
	lookupContextForAuthoritativeWrite,
	PERSISTED_BLUEPRINT_APP_COLUMNS,
	type PersistedBlueprintAppRow,
	writeBlueprintEntityDiff,
	writeCommittedBatch,
} from "./canonicalCommitKernel";
import {
	BlueprintCommitRejectedError,
	CommitReauthError,
	mutationTargetsInvalid,
	RunHolderLostError,
} from "./commitGuard";
import {
	debitAndBookReservation,
	type Reservation,
	refundStaleDesignSessionRun,
	refundStaleGeneration,
	refundStaleReservation,
	type StaleRunReapOutcome,
} from "./credits";
import { LEASE_COLUMNS, leaseView, rowReservation } from "./leaseView";
import {
	lockLookupTablesForReferenceWrite,
	readStoredLookupReferenceTargets,
	replaceLookupReferenceEdges,
} from "./lookupReferenceEdges";
import {
	deleteMediaReferenceEdges,
	insertMediaReferenceEdges,
	lockAndValidateMediaReferences,
	type MediaAssetRecord,
	MediaReferenceProjectionError,
} from "./mediaAssets";
import {
	deleteMediaAssetMetadataInTransaction,
	MediaAssetStillReferencedError,
} from "./mediaDeletion";
import { getCurrentPeriod } from "./period";
import {
	type AppDatabase,
	type AppsTable,
	getAppDb,
	notifyAppStatus,
	notifyAppStream,
	notifyPresence,
	withAppTx,
} from "./pg";
import { lockProjectMoveMemberships } from "./projectMoveAdmission";
import {
	type ExactRunHolderIdentity,
	exactRunHolderMatches,
	expectedPausedRunResumePredicate,
	expectedReapedBuildCompletionPredicate,
	expectedRunHolderPredicate,
	noRunHolderPredicate,
	type RunHolderWriteOutcome,
	toExactRunHolderIdentity,
	updatedExactlyOne,
} from "./runHolderWrites";
import {
	editLeaseDeadlineMs,
	type RunHolderIdentity,
	runLeaseState,
} from "./runLiveness";
import { type AppDoc, parsePersistedAppLifecycleStatus } from "./types";
import { hasUnfinishedMaterializedDesignInTransaction } from "./unfinishedMaterializedDesign";

// ── Types ──────────────────────────────────────────────────────────

/* The canonical commit kernel owns the guarded-commit transaction and the
 * shared locked-app plumbing every protocol in this file composes. These
 * re-exports preserve this module's public surface — external callers keep
 * importing from `@/lib/db/apps`; only server-owned commit hosts reach the
 * kernel module directly. */
export type {
	CanonicalCommitReceipt as CommitGuardedBatchResult,
	CanonicalCommitRequest as CommitGuardedBatchArgs,
	CanonicalCommitTransactionHooks as CommitGuardedBatchTransactionHooks,
	ChatRunHolderCapability,
	GuardedBatchBeforeWriteContext,
} from "./canonicalCommitKernel";
export {
	__setStrictAppLoadAfterRootReadHookForTests,
	loadAppInTransaction,
	replaceExactMediaReferencesForApp,
} from "./canonicalCommitKernel";

/** Subset of AppDoc fields returned by list queries (no blueprint assembly). */
export interface AppSummary {
	id: string;
	app_name: string;
	connect_type: AppDoc["connect_type"];
	module_count: number;
	form_count: number;
	status: AppDoc["status"];
	/** Strict app-logo asset UUID; `null` when unset. */
	logo: MediaAssetId | null;
	/** Error classification string — present only when status is 'error'. */
	error_type: string | null;
	/** ISO 8601 string. */
	created_at: string;
	/** ISO 8601 string. */
	updated_at: string;
}

/** Shape returned by `listDeletedApps` — the standard summary plus the two
 * soft-delete fields, both non-null on any row the query returns. */
export interface DeletedAppSummary extends AppSummary {
	deleted_at: string;
	recoverable_until: string;
}

/** Closed run-lifecycle filter vocabulary for list/search surfaces. */
export type AppStatus = AppDoc["status"];

/** Sort orders supported by `listApps`. `searchApps` takes none — Fuse ranks
 *  by relevance, the only sensible ordering for a search. */
export type AppsSortOrder =
	| "updated_desc"
	| "updated_asc"
	| "name_asc"
	| "name_desc";

/**
 * Structured cursor used to resume enumeration in `listApps`. Discriminated
 * by `kind`, which MUST equal the `sort` the caller is running with; the
 * server enforces the match and throws rather than silently coerce. The `id`
 * component makes `(sort_field, id)` a stable composite sort key. Wire form:
 * base64url JSON via `encodeAppsCursor`/`decodeAppsCursor`.
 */
export type ListAppsCursor =
	| { kind: "updated_desc"; updated_at: string; id: string }
	| { kind: "updated_asc"; updated_at: string; id: string }
	| { kind: "name_asc"; name_lower: string; id: string }
	| { kind: "name_desc"; name_lower: string; id: string };

/** Options consumed by `listApps`. Callers declare — no implicit defaults. */
export interface ListAppsOptions {
	limit: number;
	sort: AppsSortOrder;
	status?: AppStatus;
	cursor?: string;
}

/** Shape returned by `listApps`. Pagination cursor is opaque to callers. */
export interface ListAppsResult {
	apps: AppSummary[];
	/** Present iff the page returned exactly `limit` rows — "maybe more". */
	nextCursor?: string;
}

/** Options consumed by `searchApps`. */
export interface SearchAppsOptions {
	query: string;
	limit: number;
	status?: AppStatus;
	cursor?: string;
}

/** Shape returned by `searchApps`. Mirrors `ListAppsResult`. */
export interface SearchAppsResult {
	apps: AppSummary[];
	nextCursor?: string;
}

type AppRow = Selectable<AppsTable>;
type AppRowWithoutCaseTypes = Omit<AppRow, "case_types">;

/**
 * Delete one media metadata row for a live chat run under the same app-row,
 * authorization, Project, and holder fence used by blueprint side effects.
 * After the app/holder fence, the shared deletion core locks the asset,
 * re-walks every relevant persisted carrier, and deletes metadata on this same
 * transaction. Object-store cleanup happens only after commit.
 */
export async function deleteMediaAssetForChatRun(args: {
	appId: string;
	assetId: MediaAssetId;
	actorUserId: string;
	expectedProjectId: string;
	holder: ChatRunHolderCapability;
}): Promise<MediaAssetRecord | false> {
	return await withAppTx(async (tx) => {
		const fresh = await lockAppRow(tx, args.appId);
		if (!fresh) throw new CommitReauthError("App not found.");
		assertExpectedAppProject(fresh, args.expectedProjectId);
		await assertAppCapabilityInTransaction(
			tx,
			fresh,
			args.actorUserId,
			"edit",
			"You no longer have edit access to this app's Project.",
		);
		const lease = runLeaseState(leaseView(fresh));
		if (!exactRunHolderMatches(lease.holderIdentity, args.holder)) {
			throw new RunHolderLostError(lease.present ? "superseded" : "released");
		}
		const result = await deleteMediaAssetMetadataInTransaction(tx, {
			assetId: args.assetId,
			actorUserId: args.actorUserId,
			expectedProjectId: args.expectedProjectId,
		});
		if (result.kind === "referenced") {
			throw new MediaAssetStillReferencedError(result.references);
		}
		return result.kind === "deleted" ? result.asset : false;
	});
}

// ── Concurrency Guard ─────────────────────────────────────────────

/**
 * Whether the ACTOR has a live build in progress on ANOTHER generation
 * target — the cross-target "one build at a time per user" guard, across
 * apps AND design sessions (the scan body lives in
 * `actorGenerationGate.ts::scanActorGenerationTargets`; the claim
 * transactions run the same scan in-txn under the actor gate and fire the
 * collected reaps after commit).
 *
 * Standalone callers get the fire-and-forget stale-reap side effect.
 */
export async function hasActiveGeneration(
	actorUserId: string,
	excludeAppId?: string,
): Promise<boolean> {
	const db = await getAppDb();
	const { live, reapable } = await scanActorGenerationTargets(db, actorUserId, {
		appId: excludeAppId,
	});
	fireScanReaps(reapable);
	return live;
}

/** Fire the reapers an admission scan surfaced — post-commit, per target
 * kind. The design-session reap body lives in `credits.ts` (this module
 * cannot import `designSessions.ts`, which imports the errors below). */
function fireScanReaps(reapable: readonly ReapableGenerationTarget[]): void {
	for (const target of reapable) {
		if (target.kind === "app") {
			void reapStaleGenerating(target.appId, target.identity);
		} else {
			void refundStaleDesignSessionRun(
				target.designSessionId,
				target.identity,
			).catch((err) => {
				log.error("[apps] design-session scan reap failed", err, {
					designSessionId: target.designSessionId,
				});
			});
		}
	}
}

// ── Existence Check ───────────────────────────────────────────────

/** Does the Project have at least one live (non-soft-deleted) app? */
export async function projectHasApps(projectId: string): Promise<boolean> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("apps")
		.select("id")
		.where("project_id", "=", projectId)
		.where("deleted_at", "is", null)
		.limit(1)
		.executeTakeFirst();
	return row !== undefined;
}

// ── CRUD ───────────────────────────────────────────────────────────

/*
 * App CREATION lives in `lib/db/appGenesis.ts` — the closed
 * `explicit-blank | design-slice` genesis owner. No generic `createApp`
 * remains: every persisted app is born through `createExplicitBlankApp` or
 * the design-slice materialization, and no caller inserts an app row and
 * seeds it later.
 */

// ── Committed-batch writer ──────────────────────────────────────────

/**
 * Persist one exact Project transition. The event is inserted while the
 * locked app still carries the source Project and preceding head; only then is
 * the app advanced to the destination Project and event sequence. Database
 * triggers verify both halves at their natural points and again at commit.
 */
async function writeProjectMoveChange(
	tx: Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		readonly seq: number;
		readonly batchId: string;
		readonly prevDoc: PersistableDoc;
		readonly committedDoc: PersistedBlueprint;
		readonly mutations: AdmittedMutationBatch;
		readonly actorUserId: string;
		readonly fromProjectId: string;
		readonly toProjectId: string;
	},
): Promise<void> {
	await writeBlueprintEntityDiff(tx, args);
	await tx
		.insertInto("app_changes")
		.values({
			app_id: args.appId,
			seq: args.seq,
			batch_id: args.batchId,
			run_id: null,
			actor_id: args.actorUserId,
			kind: "project-move",
			mutations: encodeAdmittedMutationEnvelope(args.mutations).json,
			from_project_id: args.fromProjectId,
			to_project_id: args.toProjectId,
		})
		.execute();
	const update = await tx
		.updateTable("apps")
		.set({
			...denormalize(args.committedDoc),
			project_id: args.toProjectId,
			mutation_seq: args.seq,
			updated_at: new Date(),
		})
		.where("id", "=", args.appId)
		.where("project_id", "=", args.fromProjectId)
		.where("mutation_seq", "=", args.seq - 1)
		.executeTakeFirst();
	if (!updatedExactlyOne(update)) {
		throw new Error(
			`[writeProjectMoveChange] app source/head changed for appId=${args.appId}`,
		);
	}
	await notifyAppStream(tx, args.appId, args.seq);
}

/* `CommitGuardedBatchArgs` / `CommitGuardedBatchResult` /
 * `CommitGuardedBatchTransactionHooks` are re-exported near the top of this
 * file as aliases of the kernel's request/receipt/hook types. */

/**
 * The unified guarded blueprint commit — the public wrapper over the
 * canonical commit kernel (`lib/db/canonicalCommitKernel.ts`), which owns the
 * whole read-evaluate-write transaction every interactive mutation path
 * (chat, MCP, auto-save) shares. Synthetic repairs and the atomic
 * cross-Project move use the parallel locked protocols below. Ordinary
 * callers use this wrapper; only server-owned commit hosts compose kernel
 * hooks directly.
 */
export async function commitGuardedBatch(
	args: CanonicalCommitRequest,
	internalOptions: CanonicalCommitKernelOptions = {},
): Promise<CanonicalCommitReceipt> {
	return commitCanonicalBatch(args, internalOptions);
}

/**
 * Infrastructure-only transaction seam for the migration entrypoint's runtime
 * authority probe. The caller owns commit/rollback; no post-commit side effect
 * may escape that transaction.
 */
export async function commitGuardedBatchInTransaction(
	tx: Transaction<AppDatabase>,
	args: CanonicalCommitRequest,
	hooks: CanonicalCommitTransactionHooks = {},
): Promise<CanonicalCommitReceipt> {
	return commitGuardedBatch(args, { transaction: tx, ...hooks });
}

export type SyntheticBatchAuthority =
	| { readonly kind: "user"; readonly actorUserId: string }
	| {
			readonly kind: "system";
			readonly actorId: `system:${string}`;
			readonly reason: string;
	  };

export interface AppendSyntheticBatchArgs {
	readonly appId: string;
	/** Exact basis the repair/migration read before constructing `targetDoc`. */
	readonly expectedBaseSeq: number;
	readonly targetDoc: PersistedBlueprint;
	readonly authority: SyntheticBatchAuthority;
	readonly batchId?: string;
}

export type AppendSyntheticBatchResult =
	| { readonly kind: "committed"; readonly seq: number }
	| { readonly kind: "deduped"; readonly seq: number }
	| { readonly kind: "noop"; readonly seq: number };

function syntheticActorId(authority: SyntheticBatchAuthority): string {
	if (authority.kind === "user") {
		if (authority.actorUserId.trim().length === 0) {
			throw new Error("Synthetic user authority requires an actor id.");
		}
		return authority.actorUserId;
	}
	if (
		!authority.actorId.startsWith("system:") ||
		authority.actorId.length <= "system:".length ||
		authority.reason.trim().length === 0
	) {
		throw new Error(
			"Synthetic system authority requires a named system actor and reason.",
		);
	}
	// `actorId` is the durable attribution in `app_changes`; `reason` is
	// an explicit operator-callsite safeguard until the log schema gains metadata.
	return authority.actorId;
}

/**
 * Guarded repair/migration writer. It never replaces a stale whole document:
 * after locking the app it requires the caller's exact base sequence, derives
 * deterministic mutations from that fresh basis, proves their replay reaches
 * the requested target, and persists the actual batch. A true no-op writes no
 * stream row and does not advance the sequence.
 */
export async function appendSyntheticBatch(
	args: AppendSyntheticBatchArgs,
): Promise<AppendSyntheticBatchResult> {
	if (!Number.isSafeInteger(args.expectedBaseSeq) || args.expectedBaseSeq < 0) {
		throw new Error("Synthetic batch base sequence must be nonnegative.");
	}
	if (args.targetDoc.appId !== args.appId) {
		throw new BlueprintCommitRejectedError(
			"The synthetic target belongs to a different app.",
		);
	}
	const batchId = args.batchId ?? crypto.randomUUID();
	if (batchId.trim().length === 0) {
		throw new Error("Synthetic batch id must not be empty.");
	}
	const actorUserId = syntheticActorId(args.authority);
	// Hydration rebuilds derived in-memory state without changing canonical
	// identities and is independent of the locked basis. Keep it outside the
	// retryable transaction closure.
	const requestedTarget = hydratePersistedBlueprint(args.targetDoc);

	type InternalResult = AppendSyntheticBatchResult & {
		persistable?: PersistedBlueprint;
	};
	const result = await withAppTx(async (tx): Promise<InternalResult> => {
		const fresh = await lockAppRow(tx, args.appId);
		if (!fresh) {
			throw new Error("[appendSyntheticBatch] app row is unavailable");
		}
		const latch = await tx
			.selectFrom("app_changes")
			.select("seq")
			.where("app_id", "=", args.appId)
			.where("batch_id", "=", batchId)
			.executeTakeFirst();
		if (args.authority.kind === "user") {
			await assertProjectCapabilityInTransaction(
				tx,
				args.authority.actorUserId,
				fresh.project_id,
				"edit",
				"You no longer have edit access to this app's Project.",
			);
		}
		if (latch) {
			return {
				kind: "deduped",
				seq: safePersistedSequence(
					latch.seq,
					`app_changes.seq for app ${args.appId}`,
				),
			};
		}
		if (
			safePersistedSequence(
				fresh.mutation_seq,
				`apps.mutation_seq for app ${args.appId}`,
			) !== args.expectedBaseSeq
		) {
			throw new BlueprintCommitRejectedError(
				"This app changed while the repair was being prepared. Reload the latest app and prepare the repair again.",
			);
		}

		// A named system repair may be needed precisely because a strengthened
		// absolute gate exposed historical state. It receives a strictly parsed,
		// schema-admitted source and still has to land a fully gate-clean target.
		// User-attributed synthetic writes retain the ordinary strict read gate.
		const previousSnapshot =
			args.authority.kind === "system"
				? await loadSchemaAdmittedAppSnapshotFromRowInTransaction(tx, fresh)
				: await loadStrictAppSnapshotFromRowInTransaction(tx, fresh);
		const previousPersistable = previousSnapshot.app.blueprint;
		const previousDoc = previousSnapshot.doc;
		let syntheticMutations: Mutation[];
		try {
			syntheticMutations = diffDocsToMutations(previousDoc, requestedTarget);
		} catch (error) {
			if (error instanceof CasePropertySemanticProvenanceRequiredError) {
				throw new BlueprintCommitRejectedError(
					"The requested repair changes case-property identities without the original explicit rename command. Whole-document repair cannot decide whether saved case rows should move.",
				);
			}
			throw error;
		}
		const mutations = admitMutationBatch(syntheticMutations);
		const prepared = prepareMutationCandidate(previousDoc, mutations);
		const replayed = toPersistableDoc(prepared.nextDoc);
		const requested = toPersistableDoc(requestedTarget);
		if (!deepEqual(replayed, requested)) {
			throw new BlueprintCommitRejectedError(
				"The requested repair cannot be represented as a deterministic mutation batch.",
			);
		}
		if (mutations.length === 0) {
			return {
				kind: "noop",
				seq: safePersistedSequence(
					fresh.mutation_seq,
					`apps.mutation_seq for app ${args.appId}`,
				),
			};
		}
		if (mutationTargetsInvalid(previousDoc, mutations)) {
			throw new BlueprintCommitRejectedError(
				"This app changed while the repair was being prepared. Reload the latest app and prepare the repair again.",
			);
		}
		const previousTargets = extractLookupReferenceTargets(previousDoc);
		const candidateTargets = extractLookupReferenceTargets(prepared.nextDoc);
		const lookupTargets = unionLookupReferenceTargetSets(
			previousTargets,
			candidateTargets,
		);
		const lookupContext = await lookupContextForAuthoritativeWrite(
			tx,
			fresh.project_id,
			lookupTargets,
		);
		const verdict = evaluatePreparedMutationCandidate(prepared, lookupContext);
		if (!verdict.ok) {
			throw new BlueprintCommitRejectedError(
				describeCommitFindings(verdict.findings),
			);
		}
		const persistable = toPersistableDoc(verdict.nextDoc);
		const seq = nextPersistedSequence(
			fresh.mutation_seq,
			`apps.mutation_seq for app ${args.appId}`,
		);
		await admitExactMediaReferences(tx, {
			appId: args.appId,
			projectId: fresh.project_id,
			candidateDoc: verdict.nextDoc,
		});
		await applyOrganizationCommitIntegrity(tx, {
			appId: args.appId,
			previousDoc,
			candidateDoc: verdict.nextDoc,
		});
		await replaceLookupReferenceEdges(tx, {
			appId: args.appId,
			projectId: fresh.project_id,
			targets: candidateTargets,
		});
		await writeCommittedBatch(tx, {
			appId: args.appId,
			seq,
			batchId,
			prevDoc: previousPersistable,
			committedDoc: persistable,
			mutations,
			actorUserId,
			kind: "blueprint-migration",
		});
		return { kind: "committed", seq, persistable };
	});
	const { persistable: _persistable, ...publicResult } = result;
	return publicResult;
}

interface ProjectMoveThreadSnapshot {
	readonly threadId: string;
	readonly messages: readonly unknown[];
}

export type PrepareProjectMoveResult =
	| {
			kind: "ready";
			assetIds: readonly MediaAssetId[];
	  }
	| { kind: "already_moved" }
	| { kind: "busy" }
	| { kind: "reapable"; identity: ExactRunHolderIdentity }
	| { kind: "corrupt_holder" };

export type CommitMoveResult =
	| { kind: "moved" }
	| { kind: "already_moved" }
	| { kind: "media_stale"; missing: string[] }
	| { kind: "busy" }
	| { kind: "reapable"; identity: ExactRunHolderIdentity }
	| { kind: "corrupt_holder" };

interface ProjectMoveCoreArgs {
	readonly appId: string;
	readonly toProjectId: string;
	readonly expectedFromProjectId: string;
	readonly actorUserId: string;
}

interface ProjectMoveCommitArgs extends ProjectMoveCoreArgs {
	readonly assetIdMap: ReadonlyMap<MediaAssetId, MediaAssetId>;
}

async function authorizeProjectMoveGovernance(
	tx: Transaction<AppDatabase>,
	args: ProjectMoveCoreArgs,
): Promise<void> {
	const memberships = await lockProjectMoveMemberships(tx, {
		actorUserId: args.actorUserId,
		sourceProjectId: args.expectedFromProjectId,
		destinationProjectId: args.toProjectId,
	});
	if (
		memberships.sourceOwnerIds.length === 0 ||
		memberships.actorSourceRole === null ||
		memberships.actorDestinationRole === null ||
		!roleAllowsApp(memberships.actorSourceRole, "delete") ||
		!roleAllowsApp(memberships.actorDestinationRole, "delete") ||
		(!memberships.actorIsSourceOwner &&
			memberships.sourceOwnersMissingFromDestination.length > 0)
	) {
		throw new CommitReauthError(
			"You no longer have permission to move this app.",
		);
	}
}

function projectMoveRunDisposition(
	fresh: Omit<AppRow, "case_types">,
): Extract<
	PrepareProjectMoveResult,
	{ kind: "busy" | "reapable" | "corrupt_holder" }
> | null {
	const lease = runLeaseState(leaseView(fresh));
	if (lease.reapableStaleBuild || lease.reapableStrandedEdit) {
		const identity = toExactRunHolderIdentity(lease.holderIdentity);
		return identity === null
			? { kind: "corrupt_holder" }
			: { kind: "reapable", identity };
	}
	if (lease.mode === "none") return null;
	if (lease.live || lease.paused) return { kind: "busy" };
	return { kind: "corrupt_holder" };
}

async function assembleLockedProjectMoveDoc(
	tx: Transaction<AppDatabase>,
	appId: string,
	fresh: PersistedBlueprintAppRow,
): Promise<{ persisted: PersistedBlueprint; doc: BlueprintDoc }> {
	if (fresh.id !== appId) {
		throw new Error("Project-move app row does not match the requested app.");
	}
	const snapshot = await loadStrictAppSnapshotFromRowInTransaction(tx, fresh);
	return { persisted: snapshot.app.blueprint, doc: snapshot.doc };
}

/* The move's conversation set spans BOTH thread target kinds: the app's own
 * threads AND the threads of its bound design sessions (a build thread stays
 * design-session-targeted after materialization; an active pre-app session
 * has no bound app, so it never enters this set). Missing the session arm
 * would strand source-Project asset ids in a moved app's design
 * conversation and orphan its `thread_media_refs` rows in the source
 * tenant. */
function projectMoveThreadFilter(appId: string) {
	return (eb: ExpressionBuilder<AppDatabase, "threads">) =>
		eb.or([
			eb("app_id", "=", appId),
			eb(
				"design_session_id",
				"in",
				eb
					.selectFrom("design_sessions")
					.select("id")
					.where("app_id", "=", appId),
			),
		]);
}

async function readProjectMoveThreads(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<ProjectMoveThreadSnapshot[]> {
	const rows = await tx
		.selectFrom("threads")
		.select(["thread_id", "messages"])
		.where(projectMoveThreadFilter(appId))
		.orderBy("thread_id")
		.execute();
	return rows.map((row) => ({
		threadId: row.thread_id,
		messages: row.messages,
	}));
}

async function lockProjectMoveThreads(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<ProjectMoveThreadSnapshot[]> {
	const rows = await tx
		.selectFrom("threads")
		.select(["thread_id", "messages"])
		.where(projectMoveThreadFilter(appId))
		.orderBy("thread_id")
		.forUpdate()
		.execute();
	return rows.map((row) => ({
		threadId: row.thread_id,
		messages: row.messages,
	}));
}

function threadAssetIds(
	threads: readonly ProjectMoveThreadSnapshot[],
): MediaAssetId[] {
	return [
		...new Set(
			threads
				.flatMap((thread) => collectThreadAttachmentAssetIds(thread.messages))
				.filter((assetId) => !isBuiltinIconRef(assetId))
				.map(asMediaAssetId),
		),
	].sort();
}

async function assertMoveLookupClosureEmpty(
	tx: Transaction<AppDatabase>,
	appId: string,
	doc: BlueprintDoc,
): Promise<void> {
	const structural = extractLookupReferenceTargets(doc);
	const stored = await readStoredLookupReferenceTargets(tx, appId);
	if (!deepEqual(structural, stored)) {
		throw new BlueprintCommitRejectedError(
			"This app's lookup references are out of sync and must be repaired before it can move Projects.",
		);
	}
	if (hasLookupReferenceTargets(structural)) {
		throw new BlueprintCommitRejectedError(
			"This app uses lookup tables and cannot move Projects yet. Remove those references or keep the app in its current Project.",
		);
	}
}

/**
 * Capture objects are submission evidence and currently have no cross-Project
 * copy/remap closure. Block the move under the app lock instead of moving only
 * cases/media and stranding rows or bytes in the source tenant.
 */
async function assertMoveCaptureClosureEmpty(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<void> {
	const [attachment, intent] = await Promise.all([
		tx
			.selectFrom("form_attachments")
			.select("attachment_id")
			.where("app_id", "=", appId)
			.limit(1)
			.executeTakeFirst(),
		tx
			.selectFrom("form_submission_intents")
			.select("entry_key")
			.where("app_id", "=", appId)
			.limit(1)
			.executeTakeFirst(),
	]);
	if (attachment !== undefined || intent !== undefined) {
		throw new BlueprintCommitRejectedError(
			"This app has captured form submissions and cannot move Projects yet. Keep it in its current Project.",
		);
	}
}

export type RepairLookupReferenceEdgesResult =
	| { kind: "repaired" }
	| { kind: "unchanged" };

/**
 * Rederive one app's complete structural lookup target set from its committed
 * blueprint and replace the stored edge sets with it. Edges are derived state:
 * this writes no entity row, appends no history row, and advances no sequence,
 * so live streams and open runs are untouched. It is a server-only maintenance
 * writer with no route/action/MCP exposure — the paired migrate script drives
 * it over the read-only edge scan's mismatch list.
 */
export async function repairLookupReferenceEdges(
	appId: string,
): Promise<RepairLookupReferenceEdgesResult> {
	return withAppTx(async (tx) => {
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) {
			throw new Error("[repairLookupReferenceEdges] app row is unavailable");
		}
		const snapshot = await loadStrictAppSnapshotFromRowInTransaction(tx, fresh);
		const doc = snapshot.doc;
		const structural = extractLookupReferenceTargets(doc);
		const stored = await readStoredLookupReferenceTargets(tx, appId);
		if (deepEqual(structural, stored)) return { kind: "unchanged" };
		await lockLookupTablesForReferenceWrite(
			tx,
			fresh.project_id,
			structural.tableIds,
		);
		await replaceLookupReferenceEdges(tx, {
			appId,
			projectId: fresh.project_id,
			targets: structural,
		});
		return { kind: "repaired" };
	});
}

/** Production-capability wrapper. */
export async function prepareAppProjectMove(
	args: ProjectMoveCoreArgs,
): Promise<PrepareProjectMoveResult> {
	return withAppTx(async (tx) => {
		return prepareAppProjectMoveInTransaction(tx, args);
	});
}

/** Package-private v1 integration seam; caller sets the matching writer GUC. */
export async function prepareAppProjectMoveInTransaction(
	tx: Transaction<AppDatabase>,
	args: ProjectMoveCoreArgs,
): Promise<PrepareProjectMoveResult> {
	const fresh = await lockAppRow(tx, args.appId);
	if (!fresh) throw new CommitReauthError("App not found.");
	if (fresh.project_id === args.toProjectId) {
		await assertProjectCapabilityInTransaction(
			tx,
			args.actorUserId,
			args.toProjectId,
			"delete",
			"You no longer have permission to move this app.",
		);
		return { kind: "already_moved" };
	}
	if (fresh.project_id !== args.expectedFromProjectId) {
		throw new BlueprintCommitRejectedError(
			"This app changed Projects while the move was being prepared. Reload and try again.",
		);
	}
	if (fresh.deleted_at !== null) {
		throw new BlueprintCommitRejectedError(
			"Restore this app before moving it to another Project.",
		);
	}
	await authorizeProjectMoveGovernance(tx, args);
	const runDisposition = projectMoveRunDisposition(fresh);
	if (runDisposition) return runDisposition;
	if (await hasUnfinishedMaterializedDesignInTransaction(tx, args.appId)) {
		throw new BlueprintCommitRejectedError(
			"This app's reviewed initial build has not finished. Resume or discard that exact build before moving the app to another Project.",
		);
	}
	const { doc } = await assembleLockedProjectMoveDoc(tx, args.appId, fresh);
	await assertMoveLookupClosureEmpty(tx, args.appId, doc);
	await assertMoveCaptureClosureEmpty(tx, args.appId);
	const threads = await readProjectMoveThreads(tx, args.appId);
	return {
		kind: "ready",
		assetIds: [
			...new Set([
				...collectRealAssetRefs(asWalkableDoc(doc)),
				...threadAssetIds(threads),
			]),
		].sort(),
	};
}

/**
 * Same-Project recovery is case-only and follows the freshly locked app row.
 * It writes no migration batch and purges no presence, so either race order
 * with a true move converges on the winner's current Project.
 */
export async function repairAppCaseTenancy(
	appId: string,
	actorUserId: string,
): Promise<{ projectId: string; moved: number }> {
	return withAppTx(async (tx) => {
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) throw new CommitReauthError("App not found.");
		await assertAppCapabilityInTransaction(
			tx,
			fresh,
			actorUserId,
			"delete",
			"You no longer have permission to repair this app.",
		);
		const fullTx = tx as unknown as Transaction<AppDatabase & CaseDatabase>;
		const repaired = await retenantAppCasesOn(
			fullTx.$pickTables<keyof CaseDatabase>(),
			{ appId, toProjectId: fresh.project_id },
		);
		return { projectId: fresh.project_id, moved: repaired.moved };
	});
}

/** Production-capability wrapper. */
export async function commitAppProjectMove(
	appId: string,
	args: Omit<ProjectMoveCommitArgs, "appId">,
): Promise<CommitMoveResult> {
	const batchId = crypto.randomUUID();
	return withAppTx(async (tx) => {
		return commitAppProjectMoveInTransaction(
			tx,
			{ ...args, appId },
			{ batchId },
		);
	});
}

/** Package-private seam for callers that already own the transaction. */
export async function commitAppProjectMoveInTransaction(
	tx: Transaction<AppDatabase>,
	args: ProjectMoveCommitArgs,
	capabilities: { readonly batchId: string },
): Promise<CommitMoveResult> {
	const fresh = await lockAppRow(tx, args.appId);
	if (!fresh) throw new CommitReauthError("App not found.");
	if (fresh.project_id === args.toProjectId) {
		await assertProjectCapabilityInTransaction(
			tx,
			args.actorUserId,
			args.toProjectId,
			"delete",
			"You no longer have permission to move this app.",
		);
		return { kind: "already_moved" };
	}
	if (fresh.project_id !== args.expectedFromProjectId) {
		throw new BlueprintCommitRejectedError(
			"This app changed Projects while the move was being prepared. Reload and try again.",
		);
	}
	if (fresh.deleted_at !== null) {
		throw new BlueprintCommitRejectedError(
			"Restore this app before moving it to another Project.",
		);
	}
	await authorizeProjectMoveGovernance(tx, args);
	const runDisposition = projectMoveRunDisposition(fresh);
	if (runDisposition) return runDisposition;
	if (await hasUnfinishedMaterializedDesignInTransaction(tx, args.appId)) {
		throw new BlueprintCommitRejectedError(
			"This app's reviewed initial build has not finished. Resume or discard that exact build before moving the app to another Project.",
		);
	}

	const { persisted: previousPersisted, doc: previousDoc } =
		await assembleLockedProjectMoveDoc(tx, args.appId, fresh);
	await assertMoveLookupClosureEmpty(tx, args.appId, previousDoc);
	await assertMoveCaptureClosureEmpty(tx, args.appId);
	const threads = await lockProjectMoveThreads(tx, args.appId);
	const freshClosure = [
		...new Set([
			...collectRealAssetRefs(asWalkableDoc(previousDoc)),
			...threadAssetIds(threads),
		]),
	].sort();
	const staleSources = new Set(
		freshClosure.filter((assetId) => !args.assetIdMap.has(assetId)),
	);
	if (staleSources.size > 0) {
		return { kind: "media_stale", missing: [...staleSources].sort() };
	}

	const requestedCandidate =
		args.assetIdMap.size > 0
			? hydratePersistedBlueprint(
					remapAssetRefs(toPersistableDoc(previousDoc), args.assetIdMap),
				)
			: previousDoc;
	const mutations = admitMutationBatch(
		diffDocsToMutations(previousDoc, requestedCandidate),
	);
	const prepared = prepareMutationCandidate(previousDoc, mutations);
	if (
		!deepEqual(
			toPersistableDoc(prepared.nextDoc),
			toPersistableDoc(requestedCandidate),
		)
	) {
		throw new BlueprintCommitRejectedError(
			"The app's media references could not be remapped deterministically.",
		);
	}
	const destinationContext = await lookupContextForAuthoritativeWrite(
		tx,
		args.toProjectId,
		EMPTY_LOOKUP_REFERENCE_TARGETS,
	);
	const verdict = evaluatePreparedMutationCandidate(
		prepared,
		destinationContext,
	);
	if (!verdict.ok) {
		throw new BlueprintCommitRejectedError(
			describeCommitFindings(verdict.findings),
		);
	}
	const committedDoc = toPersistableDoc(verdict.nextDoc);
	const remappedThreads = threads.map((thread) => ({
		...thread,
		messages: remapThreadAttachmentAssetIds(thread.messages, args.assetIdMap),
	}));
	/* The Blueprint half of the split projection: the destination edges are
	 * exactly the committed (already remapped) doc's authored references.
	 * Conversation carriers ride each thread's own `thread_media_refs`
	 * replacement below. Both families still validate against the
	 * destination Project in ONE lock set here. */
	const blueprintDestinationRequirements = blueprintMediaRequirements(
		verdict.nextDoc,
	);
	const destinationRequirements = [...blueprintDestinationRequirements];
	for (const thread of remappedThreads) {
		for (const attachment of collectThreadAttachments(thread.messages)) {
			destinationRequirements.push({
				assetId: attachment.assetId,
				expectedKind: attachment.kind as AssetKind,
			});
		}
	}
	try {
		await lockAndValidateMediaReferences(
			tx,
			args.toProjectId,
			destinationRequirements,
		);
	} catch (error) {
		if (error instanceof MediaReferenceProjectionError) {
			const missingSource = [...args.assetIdMap].find(
				([, destinationId]) => destinationId === error.assetId,
			)?.[0];
			return {
				kind: "media_stale",
				missing: missingSource ? [missingSource] : freshClosure,
			};
		}
		throw error;
	}
	await deleteMediaReferenceEdges(tx, args.appId);
	await replaceLookupReferenceEdges(tx, {
		appId: args.appId,
		projectId: args.toProjectId,
		targets: EMPTY_LOOKUP_REFERENCE_TARGETS,
	});
	for (const thread of remappedThreads) {
		if (
			!deepEqual(
				thread.messages,
				threads.find((source) => source.threadId === thread.threadId)?.messages,
			)
		) {
			await tx
				.updateTable("threads")
				.set({ messages: JSON.stringify(thread.messages) })
				.where(projectMoveThreadFilter(args.appId))
				.where("thread_id", "=", thread.threadId)
				.execute();
		}
		/* Re-tenant this thread's exact conversation reference set: the same
		 * remapped transcript that just committed is the projection source,
		 * so the rows land destination-Project-scoped with destination asset
		 * ids (the destination lock set above already validated them). */
		await tx
			.deleteFrom("thread_media_refs")
			.where("thread_id", "=", thread.threadId)
			.execute();
		const threadAssetRows = [
			...new Set(
				collectThreadAttachments(thread.messages).map((ref) => ref.assetId),
			),
		].sort();
		if (threadAssetRows.length > 0) {
			await tx
				.insertInto("thread_media_refs")
				.values(
					threadAssetRows.map((assetId) => ({
						thread_id: thread.threadId,
						asset_id: assetId,
						project_id: args.toProjectId,
					})),
				)
				.execute();
		}
	}
	/* Materialized/completed/edit design sessions follow their bound app's
	 * Project (§18.14). Active pre-app sessions carry no `app_id` and never
	 * move; open change sets deliberately stay on their captured base scope. */
	await tx
		.updateTable("design_sessions")
		.set({ project_id: args.toProjectId, updated_at: new Date() })
		.where("app_id", "=", args.appId)
		.execute();
	/* Completed external prerequisites are Project-scoped evidence. They follow
	 * their materialized app in the same move transaction; pre-app receipts
	 * have no app id and therefore never move. */
	await tx
		.updateTable("design_external_action_receipts")
		.set({ project_id: args.toProjectId })
		.where("app_id", "=", args.appId)
		.execute();
	const fullTx = tx as unknown as Transaction<AppDatabase & CaseDatabase>;
	await retenantAppCasesOn(fullTx.$pickTables<keyof CaseDatabase>(), {
		appId: args.appId,
		toProjectId: args.toProjectId,
	});
	/* Deployments move with the app, exactly as case rows do.
	 *
	 * Unlike case rows they carry NO composite tenant foreign key (the
	 * auth-app tenancy migration's catalog forbids a second one), so
	 * nothing in the database will catch it if this update is removed —
	 * the rows would silently stay in the source Project and be invisible
	 * to every member of the destination. `projectMove.integration.test.ts`
	 * asserts the row actually moved, rather than that the move succeeded.
	 *
	 * What the destination inherits is the honest record of where this app
	 * has been published; whether its members' own API keys reach those
	 * project spaces is a separate question their next publish answers. */
	await tx
		.updateTable("app_deployments")
		.set({ project_id: args.toProjectId })
		.where("app_id", "=", args.appId)
		.execute();
	await tx.deleteFrom("presence").where("app_id", "=", args.appId).execute();
	const seq = nextPersistedSequence(
		fresh.mutation_seq,
		`apps.mutation_seq for app ${args.appId}`,
	);
	await writeProjectMoveChange(tx, {
		appId: args.appId,
		seq,
		batchId: capabilities.batchId,
		prevDoc: previousPersisted,
		committedDoc,
		mutations,
		actorUserId: args.actorUserId,
		fromProjectId: fresh.project_id,
		toProjectId: args.toProjectId,
	});
	await insertMediaReferenceEdges(tx, {
		appId: args.appId,
		projectId: args.toProjectId,
		assetIds: blueprintDestinationRequirements.map((entry) => entry.assetId),
	});
	await notifyPresence(tx, args.appId);
	return { kind: "moved" };
}

// ── Run lifecycle ───────────────────────────────────────────────────

/**
 * Thrown by `claimAndReserveRun` when the app's run window is already held —
 * a live build or edit, OR another actor's paused run (a paused run is not a
 * claimable takeover; the claimant's OWN paused run is superseded instead of
 * conflicting). The chat route serializes-with-wait on it. Carries the
 * reapable flags so the waiter-side nudge can free an abandoned holder.
 */
export class RunConflictError extends Error {
	constructor(
		readonly reapableStaleBuild = false,
		readonly reapableStrandedEdit = false,
		readonly reapableIdentity: ExactRunHolderIdentity | null = null,
		/* The default names the app target; the design-session claim passes
		 * its own wording — a pre-app conflict must not tell the user about
		 * "this app" when no app exists yet. */
		message = "Another request is already running on this app, only one run can work on an app at a time.",
	) {
		super(message);
		this.name = "RunConflictError";
	}
}

/**
 * Thrown by the claim transaction when the actor already has a live build on
 * another app (the cross-app "one build at a time per user" cap). The check
 * runs INSIDE the claim transaction — after the row lock, before the debit —
 * so a rejected claim is a rollback that held nothing.
 */
export class GenerationInProgressError extends Error {
	constructor() {
		super("A build is already running for this user.");
		this.name = "GenerationInProgressError";
	}
}

/**
 * Thrown by the claim transaction (opt-in via `requireModeMatchesStatus`)
 * when the caller's build-vs-edit mode no longer matches the LOCKED row's
 * status: only a `complete` app claims as an edit; everything else claims as
 * a build. The chat route derives its mode from an unlocked snapshot read,
 * and a serialize-wait can hold that read stale for up to two minutes — long
 * enough for the awaited build to complete, which would let a "build" claim
 * flip the finished app back to `generating` and book the build rate for what
 * is now an edit. The rejection is a rollback that held nothing; `statusMode`
 * is the mode the locked row supports, so the caller re-derives and retries
 * instead of guessing.
 */
export class ClaimModeStaleError extends Error {
	constructor(readonly statusMode: "build" | "edit") {
		super(
			"The app's state changed while this request waited, so its build-vs-edit mode was re-derived before claiming.",
		);
		this.name = "ClaimModeStaleError";
	}
}

/** What a successful claim returns. There is no prior-state snapshot to
 *  restore: every rejection is a transaction rollback. */
export interface ClaimedRun {
	mode: "build" | "edit";
	reservation: Reservation;
	holderNonce: string;
}

/**
 * Claim the app's run window for `mode` AND reserve the run's credits — ONE
 * transaction, the per-app serialization primitive for both SA modes.
 *
 * Inside the transaction, in order:
 *  1. Lock the app row. Busy (`lease.live`, or another actor's paused run)
 *     throws {@link RunConflictError}. The claimant's OWN paused run does NOT
 *     block — it is SUPERSEDED: an abandoned `askQuestions` round (its ask
 *     card lost to a reload) would otherwise hold the app until its lease
 *     lapses, locking the user out of their own app; steps 3–4 already refund
 *     its hold and overwrite its lock/pause, and its late answer bails via
 *     `reacquireLease`. A FREE app (`complete`/`error` at rest, or a
 *     hard-killed run past its horizon) falls through.
 *  2. For a BUILD claim, the cross-app concurrency scan
 *     ({@link GenerationInProgressError} when the actor has another live
 *     build) — the same check-after-claim ordering as ever, now atomic with
 *     the claim so a rejection never needs a restore.
 *  3. Refund any leftover UNSETTLED marker (a superseded run's stranded
 *     hold), check affordability against the literal balance, debit, and
 *     book the fresh marker — `debitAndBookReservation`.
 *  4. The claim writes: build → `status: generating` + root `run_id = runId`
 *     + fresh `updated_at`, clear `error_type`/`awaiting_input`/any stale lock;
 *     edit → fresh
 *     `run_lock` lease + normalize `status → complete`.
 *
 * Because claim and reserve commit together, a claimed app ALWAYS carries the
 * claimant's fresh marker — "claimed but unreserved" is unrepresentable, and
 * every bail-out (busy, concurrency, out-of-credits, infrastructure) is a
 * rollback that left the app exactly as it found it.
 *
 * On a `RunConflictError` with a reapable holder, the matching reaper is
 * fired (awaited) before rethrowing, so a waiter's next poll deterministically
 * finds an abandoned holder freed.
 */
export async function claimAndReserveRun(
	appId: string,
	mode: "build" | "edit",
	runId: string,
	actorUserId: string,
	cost: number,
	expectedProjectId: string,
	holderNonce: string = crypto.randomUUID(),
	opts?: {
		/** Reject (`ClaimModeStaleError`) instead of claiming when `mode` no
		 *  longer matches the LOCKED row's status (`complete` → edit, anything
		 *  else → build). The chat route always passes this: its mode comes
		 *  from an unlocked snapshot that a serialize-wait can hold stale.
		 *  Left off, the claim keeps its historical trust-the-caller shape
		 *  (the lifecycle suites exercise deliberate mode/status splits). */
		requireModeMatchesStatus?: boolean;
	},
): Promise<ClaimedRun> {
	const period = getCurrentPeriod();
	try {
		const reapable: ReapableGenerationTarget[] = [];
		const claimed = await withAppTx(async (tx) => {
			/* The body re-runs from scratch on a deadlock/serialization retry —
			 * reset the collector so a retried scan doesn't double-book reaps. */
			reapable.length = 0;
			/* Lifecycle lock order: the claimant's actor gate FIRST, then the
			 * authority row — the one serialization point for this actor's
			 * admissions across apps AND design sessions
			 * (`actorGenerationGate.ts`). */
			await lockActorGenerationGate(tx, actorUserId);
			const fresh = await lockAppRow(tx, appId);
			if (!fresh) {
				throw new Error(
					`[claimAndReserveRun] app row missing for appId=${appId}`,
				);
			}
			assertExpectedAppProject(fresh, expectedProjectId);
			await assertAppCapabilityInTransaction(
				tx,
				fresh,
				actorUserId,
				"edit",
				"You no longer have edit access to this app's Project.",
			);
			const lease = runLeaseState(leaseView(fresh));
			/* Busy — with one carve-out: the claimant's OWN paused run does not
			 * block. A paused run is process-less and its ask card may be gone
			 * entirely (a reload opens a fresh conversation), so the same actor's
			 * new instruction supersedes it: the marker refund below returns the
			 * abandoned round's hold to this same actor, the claim writes clear
			 * `awaiting_input` + the lock in both arms, and the old run's answer
			 * (if it ever arrives) bails through `reacquireLease`'s supersede
			 * guard. Another actor's pause still blocks — their answer round is
			 * theirs to finish — and a LIVE run always blocks. */
			if (lease.live || (lease.paused && !lease.pausedBy(actorUserId))) {
				throw new RunConflictError(
					lease.reapableStaleBuild,
					lease.reapableStrandedEdit,
					toExactRunHolderIdentity(lease.holderIdentity),
				);
			}
			/* Mode-vs-status agreement, read off the LOCKED row so it cannot be
			 * stale. Checked only once the app is claimable: a busy app keeps
			 * reading as a conflict (the waiter re-derives when it re-polls). */
			if (opts?.requireModeMatchesStatus) {
				const statusMode = fresh.status === "complete" ? "edit" : "build";
				if (statusMode !== mode) throw new ClaimModeStaleError(statusMode);
			}
			if (mode === "build") {
				const scan = await scanActorGenerationTargets(tx, actorUserId, {
					appId,
				});
				reapable.push(...scan.reapable);
				if (scan.live) throw new GenerationInProgressError();
			}
			await debitAndBookReservation(tx, {
				appId,
				userId: actorUserId,
				cost,
				runId,
				holderNonce,
				period,
				priorMarker: rowReservation(fresh),
				owner: fresh.owner,
			});
			if (mode === "edit") {
				/* Edit lease — status/error_type NORMALIZED: an edit's postcondition
				 * is a `complete` app, and its clean finalize never touches status,
				 * so a stale `generating`/`error` row it claimed must be normalized
				 * here or the edit completes onto a row the reaper flips to error. */
				await tx
					.updateTable("apps")
					.set({
						status: "complete",
						error_type: null,
						awaiting_input: false,
						lock_run_id: runId,
						lock_actor_user_id: actorUserId,
						lock_expire_at: new Date(editLeaseDeadlineMs()),
					})
					.where("id", "=", appId)
					.execute();
			} else {
				/* Build claim — flip to a live `generating` run with a FRESH
				 * `updated_at` (the row's old timestamp belongs to a dead prior run
				 * and may already sit outside the staleness window), clearing any
				 * stale lock a hard-killed prior edit left. */
				await tx
					.updateTable("apps")
					.set({
						status: "generating",
						error_type: null,
						awaiting_input: false,
						/* Durable latest-build claim identity. Even if this run never
						 * commits a mutation and is later reaped, an older zombie cannot
						 * satisfy the false-reap self-heal's root `run_id` check. */
						run_id: runId,
						updated_at: new Date(),
						lock_run_id: null,
						lock_actor_user_id: null,
						lock_expire_at: null,
					})
					.where("id", "=", appId)
					.execute();
			}
			return { mode, reservation: { period, reserved: cost }, holderNonce };
		});
		fireScanReaps(reapable);
		return claimed;
	} catch (err) {
		/* A conflict with a REAPABLE holder — an abandoned run whose lease
		 * lapsed. Run the matching reaper on the waiter's own path (awaited, so
		 * the next poll deterministically finds the freed app); each reaper
		 * re-validates its staleness in-txn and swallows its own faults. */
		if (err instanceof RunConflictError) {
			if (err.reapableIdentity !== null) {
				if (err.reapableStaleBuild) {
					await reapStaleGenerating(appId, err.reapableIdentity);
				} else if (err.reapableStrandedEdit) {
					await reapStaleReservation(appId, err.reapableIdentity);
				}
			}
		}
		throw err;
	}
}

/**
 * Reserve credits for a JUST-CREATED build (the `createApp`-born app, which
 * this same POST owns — no claim arm, the fresh `generating` row IS the
 * claim). Same transaction contents otherwise: the cross-app concurrency
 * scan, the (vacuous) leftover refund, the literal-balance debit, the marker.
 */
export async function reserveForNewBuild(
	appId: string,
	actorUserId: string,
	cost: number,
	runId: string,
	expectedProjectId: string,
	holderNonce: string,
): Promise<Reservation> {
	const period = getCurrentPeriod();
	const reapable: ReapableGenerationTarget[] = [];
	const reservation = await withAppTx(async (tx) => {
		reapable.length = 0;
		/* Lifecycle lock order: actor gate first (see `claimAndReserveRun`). */
		await lockActorGenerationGate(tx, actorUserId);
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) {
			throw new Error(
				`[reserveForNewBuild] app row missing for appId=${appId}`,
			);
		}
		assertExpectedAppProject(fresh, expectedProjectId);
		await assertAppCapabilityInTransaction(
			tx,
			fresh,
			actorUserId,
			"edit",
			"You no longer have edit access to this app's Project.",
		);
		const lease = runLeaseState(leaseView(fresh));
		const expectedHolder = {
			mode: "build",
			runId,
			nonce: holderNonce,
		} as const;
		if (!exactRunHolderMatches(lease.holderIdentity, expectedHolder)) {
			throw new RunConflictError(
				lease.reapableStaleBuild,
				lease.reapableStrandedEdit,
				toExactRunHolderIdentity(lease.holderIdentity),
			);
		}
		const scan = await scanActorGenerationTargets(tx, actorUserId, { appId });
		reapable.push(...scan.reapable);
		if (scan.live) throw new GenerationInProgressError();
		await debitAndBookReservation(tx, {
			appId,
			userId: actorUserId,
			cost,
			runId,
			holderNonce,
			period,
			priorMarker: rowReservation(fresh),
			owner: fresh.owner,
		});
		return { period, reserved: cost };
	});
	fireScanReaps(reapable);
	return reservation;
}

/**
 * Clean BUILD completion — flip `generating → complete` AND settle the run's
 * kept-charge reservation marker in ONE transaction (the one drain-end build
 * finalizer; there is no status-only variant). The atomicity is load-bearing:
 * `complete` is what makes the app CLAIMABLE, and a settled marker is what
 * tells the next reservation "this charge was kept" — separate writes would
 * open the window where a landing edit claws back the kept 100 credits.
 *
 * OWNERSHIP-GATED at write time through the one liveness reader: a
 * reaped-then-RE-CLAIMED build's stale completion no-ops instead of
 * clobbering the taker. A reaped-but-UNCLAIMED build (the false-reap: a live
 * run whose clock lapsed was refunded + flipped to `error`, then finished
 * cleanly) takes the SELF-HEAL branch — the reaper's signature (settled
 * marker, `runId` cleared) + `mode: "none"` + `status: "error"` +
 * `run_id === runId` (the latest build claim or committed batch is THIS run's)
 * flips the row back to `complete` without touching the marker; the reaper's
 * refund stands. A pre-settled stale marker retains `runId`, so it is not this
 * signature and cannot enter the self-heal branch.
 *
 * `expectedMutationSeq` is the optional canonical-head fence used by
 * authoritative initial-build completion after receipt and compile proof.
 */
export async function completeAndSettleRun(
	appId: string,
	runId: string,
	holderNonce: string,
	expectedMutationSeq?: number,
): Promise<RunHolderWriteOutcome> {
	return await withAppTx(async (tx) => {
		/* Lifecycle lock order: the holder's actor gate first (settle is a
		 * holder/reservation transition — see `actorGenerationGate.ts`). */
		await lockActorGenerationGateForAppHolder(tx, appId);
		return await completeAndSettleRunInTransaction(
			tx,
			appId,
			runId,
			holderNonce,
			expectedMutationSeq,
		);
	});
}

/**
 * Transaction body for {@link completeAndSettleRun}. The caller MUST already
 * hold the current app holder's actor-generation gate. Kept separate so the
 * reviewed-build finalizer can commit the exact terminal orchestration event,
 * the `generating -> complete` transition, and reservation settlement as one
 * database decision instead of releasing its authority between those writes.
 */
export async function completeAndSettleRunInTransaction(
	tx: Transaction<AppDatabase>,
	appId: string,
	runId: string,
	holderNonce: string,
	expectedMutationSeq?: number,
): Promise<RunHolderWriteOutcome> {
	const fresh = await lockAppRow(tx, appId);
	if (!fresh) return "released";
	const lease = runLeaseState(leaseView(fresh));
	const expectedHolder = {
		mode: "build",
		runId,
		nonce: holderNonce,
	} as const;
	if (
		!exactRunHolderMatches(lease.holderIdentity, expectedHolder) ||
		!lease.terminalWriteOwned(runId)
	) {
		if (
			fresh.status === "error" &&
			lease.mode === "none" &&
			lease.reaperResolved &&
			fresh.run_id === runId &&
			fresh.run_holder_nonce === holderNonce
		) {
			let query = tx
				.updateTable("apps")
				.set({ status: "complete", error_type: null })
				.where("id", "=", appId)
				.where(expectedReapedBuildCompletionPredicate(expectedHolder));
			if (expectedMutationSeq !== undefined) {
				query = query.where("mutation_seq", "=", expectedMutationSeq);
			}
			const result = await query.executeTakeFirst();
			if (!updatedExactlyOne(result)) return "released";
			await notifyAppStatus(tx, appId);
			return "owned";
		}
		return lease.present ? "superseded" : "released";
	}
	let query = tx
		.updateTable("apps")
		.set({ status: "complete", error_type: null, res_settled: true })
		.where("id", "=", appId)
		.where(expectedRunHolderPredicate(expectedHolder));
	if (expectedMutationSeq !== undefined) {
		query = query.where("mutation_seq", "=", expectedMutationSeq);
	}
	const result = await query.executeTakeFirst();
	if (!updatedExactlyOne(result)) return "superseded";
	/* Delivered on commit: connected builder streams re-read + re-announce
	 * the app status, so a co-member tab's build-rate latch releases the
	 * moment the build completes instead of on the next reauth cadence. */
	await notifyAppStatus(tx, appId);
	return "owned";
}

/**
 * Refresh a live EDIT run's `run_lock` lease off SA activity — the per-STEP
 * heartbeat, complementing the per-commit refresh inside the guarded commit.
 * Ownership-gated through the one reader: a superseded run never extends the
 * taker's lease; a build (no lock) is a clean no-op.
 */
export async function refreshEditLease(
	appId: string,
	runId: string,
	holderNonce: string,
): Promise<void> {
	await withAppTx(async (tx) => {
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) return;
		const lease = runLeaseState(leaseView(fresh));
		const expectedHolder = { mode: "edit", runId, nonce: holderNonce } as const;
		if (!exactRunHolderMatches(lease.holderIdentity, expectedHolder)) {
			return;
		}
		await tx
			.updateTable("apps")
			.set({ lock_expire_at: new Date(editLeaseDeadlineMs()) })
			.where("id", "=", appId)
			.where(expectedRunHolderPredicate(expectedHolder))
			.execute();
	});
}

/**
 * Refresh a live BUILD run's liveness clock (`updated_at`) off SA activity —
 * the build-mode twin of {@link refreshEditLease}, keeping a long no-commit
 * stretch (planning, extraction, a validator loop) from drifting past the
 * staleness window and being reaped mid-run. Ownership-gated; the
 * pre-reservation window reads unowned and no-ops (harmless — the claim just
 * stamped a fresh `updated_at`).
 */
export async function refreshBuildLiveness(
	appId: string,
	runId: string,
	holderNonce: string,
): Promise<void> {
	await withAppTx(async (tx) => {
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) return;
		const lease = runLeaseState(leaseView(fresh));
		const expectedHolder = {
			mode: "build",
			runId,
			nonce: holderNonce,
		} as const;
		if (!exactRunHolderMatches(lease.holderIdentity, expectedHolder)) {
			return;
		}
		await tx
			.updateTable("apps")
			.set({ updated_at: new Date() })
			.where("id", "=", appId)
			.where(expectedRunHolderPredicate(expectedHolder))
			.execute();
	});
}

/**
 * Release an edit run's `run_lock` WITHOUT touching the reservation marker —
 * for terminal states that are NOT a clean kept-charge completion (a failed
 * edit whose marker the failure funnel already settled, the prelude-throw
 * net's release of a stranded lock).
 *
 * The exact `runId` is re-checked through the one liveness reader while the app
 * row is locked. A reaped run or a replacement holder therefore makes this a
 * no-op instead of letting a stale prelude cleanup clear the new run's lock.
 * Best-effort: a storage failure degrades to the lock expiring at `expireAt`.
 */
export async function clearRunLock(
	appId: string,
	runId: string,
	holderNonce: string,
): Promise<void> {
	try {
		await withAppTx(async (tx) => {
			/* Lifecycle lock order: the holder's actor gate first (a release). */
			await lockActorGenerationGateForAppHolder(tx, appId);
			const fresh = await lockAppRow(tx, appId);
			if (!fresh) return;
			const lease = runLeaseState(leaseView(fresh));
			const expectedHolder = {
				mode: "edit",
				runId,
				nonce: holderNonce,
			} as const;
			if (!exactRunHolderMatches(lease.holderIdentity, expectedHolder)) {
				return;
			}
			await tx
				.updateTable("apps")
				.set({
					lock_run_id: null,
					lock_actor_user_id: null,
					lock_expire_at: null,
				})
				.where("id", "=", appId)
				.where(expectedRunHolderPredicate(expectedHolder))
				.execute();
		});
	} catch (err) {
		log.error("[clearRunLock] write failed", err, { appId, runId });
	}
}

/**
 * Clean EDIT completion — delete the `run_lock` AND settle the kept charge in
 * ONE transaction (the edit-mode analogue of {@link completeAndSettleRun};
 * the lock being gone is what makes an edit claimable). Ownership-gated so
 * the reaper-race no-ops rather than double-freeing.
 */
export async function clearRunLockAndSettle(
	appId: string,
	runId: string,
	holderNonce: string,
): Promise<RunHolderWriteOutcome> {
	return await withAppTx(async (tx) => {
		/* Lifecycle lock order: the holder's actor gate first. */
		await lockActorGenerationGateForAppHolder(tx, appId);
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) return "released";
		const lease = runLeaseState(leaseView(fresh));
		const expectedHolder = { mode: "edit", runId, nonce: holderNonce } as const;
		if (
			!exactRunHolderMatches(lease.holderIdentity, expectedHolder) ||
			!lease.terminalWriteOwned(runId)
		) {
			return lease.present ? "superseded" : "released";
		}
		const reservation = rowReservation(fresh);
		const result = await tx
			.updateTable("apps")
			.set({
				lock_run_id: null,
				lock_actor_user_id: null,
				lock_expire_at: null,
				...(reservation && !reservation.settled && { res_settled: true }),
			})
			.where("id", "=", appId)
			.where(expectedRunHolderPredicate(expectedHolder))
			.executeTakeFirst();
		return updatedExactlyOne(result) ? "owned" : "superseded";
	});
}

/**
 * Whether ANY run currently holds this app live — within its mode's liveness
 * horizon and not paused. The resumable-stream endpoint's fallback signal: a
 * tailer waiting on a stream with no terminal row uses this to distinguish
 * "a run on this app may still produce chunks" (keep tailing) from "nothing
 * holds the app — the producing process died without sealing the log" (close
 * the tail). Deliberately NOT keyed to the tailed stream's own run: during
 * serialize-with-wait the tailed POST holds nothing while it polls behind the
 * live holder, and keying on its runId would falsely close a healthy waiter's
 * resumed stream. Read-only; derives through `runLeaseState` like every
 * liveness decision.
 */
export async function appHeldLive(appId: string): Promise<boolean> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("apps")
		.select(LEASE_COLUMNS)
		.where("id", "=", appId)
		.executeTakeFirst();
	if (!row) return false;
	return runLeaseState(leaseView(row as AppRow)).live;
}

/**
 * Re-acquire a free-continuation resume's paused run — the supersede guard
 * AND lease re-establishment in one transaction, uniform across both modes.
 * A paused run's lease lapses while the user answers (no heartbeat during a
 * pause), so it can be reaped and the freed app re-claimed; the resume must
 * still OWN the PAUSED run as its original actor (`ownedByResume`, keyed on
 * the resume's own mode) and
 * RENEW its horizon (edit → re-stamp the lease; build → re-arm `updated_at`)
 * + clear `awaiting_input` atomically. A lost resume touched nothing; the
 * return distinguishes WHY so the route's message can be true:
 * `"superseded"` (another run occupies the freed app) vs `"released"` (the
 * reap simply freed it — on a personal Project the only lost shape).
 */
export type ReacquireOutcome = "owned" | "superseded" | "released";
export type ReacquireLeaseResult =
	| { readonly outcome: "owned"; readonly holderNonce: string }
	| {
			readonly outcome: "superseded" | "released" | "refresh_required";
	  };

export async function reacquireLease(
	appId: string,
	runId: string,
	presentedHolderNonce: string | null,
	mode: "build" | "edit",
	actorUserId: string,
	expectedProjectId: string,
): Promise<ReacquireLeaseResult> {
	return await withAppTx(async (tx) => {
		/* Lifecycle lock order: the resuming actor's gate first (a resume can
		 * restore a holder's liveness). */
		await lockActorGenerationGate(tx, actorUserId);
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) return { outcome: "released" };
		assertExpectedAppProject(fresh, expectedProjectId);
		await assertAppCapabilityInTransaction(
			tx,
			fresh,
			actorUserId,
			"edit",
			"You no longer have edit access to this app's Project.",
		);
		const lease = runLeaseState(leaseView(fresh));
		/* Prove the mode/run/actor pause identity BEFORE the nonce. That proof is
		 * what separates "refresh your stale tab" from a run another holder
		 * genuinely superseded or a reaper released — collapsing the two would
		 * report every taken-over round as a client-refresh problem. It does not
		 * weaken the exact nonce check below, which still runs on every resume. */
		if (!lease.ownedByResume(runId, mode, actorUserId, null, false)) {
			return { outcome: lease.present ? "superseded" : "released" };
		}
		if (
			presentedHolderNonce === null ||
			!lease.ownedByResume(runId, mode, actorUserId, presentedHolderNonce, true)
		) {
			return { outcome: "refresh_required" };
		}
		const effectiveHolderNonce = presentedHolderNonce;
		const expectedHolder = {
			mode,
			runId,
			nonce: effectiveHolderNonce,
		} as const;
		let result: UpdateResult;
		if (mode === "edit") {
			result = await tx
				.updateTable("apps")
				.set({
					lock_expire_at: new Date(editLeaseDeadlineMs()),
					awaiting_input: false,
					run_holder_nonce: effectiveHolderNonce,
				})
				.where("id", "=", appId)
				.where(expectedPausedRunResumePredicate(expectedHolder, actorUserId))
				.executeTakeFirst();
		} else {
			result = await tx
				.updateTable("apps")
				.set({
					updated_at: new Date(),
					awaiting_input: false,
					run_holder_nonce: effectiveHolderNonce,
				})
				.where("id", "=", appId)
				.where(expectedPausedRunResumePredicate(expectedHolder, actorUserId))
				.executeTakeFirst();
		}
		return updatedExactlyOne(result)
			? { outcome: "owned", holderNonce: effectiveHolderNonce }
			: { outcome: "superseded" };
	});
}

/**
 * Mark a BUILD as failed only while `runId` still owns that exact holder.
 * Ownership is re-checked under the app lock, including the just-created
 * pre-reservation fallback; a reaped or replacement run makes this a no-op.
 * Storage failure remains best-effort because the canonical stale-build reaper
 * is the backstop.
 */
export async function failApp(
	appId: string,
	runId: string,
	holderNonce: string,
	errorType: ErrorType,
): Promise<boolean> {
	try {
		return await withAppTx(async (tx) => {
			/* Lifecycle lock order: the holder's actor gate first (a build's
			 * error flip releases its status-held run window). */
			await lockActorGenerationGateForAppHolder(tx, appId);
			const fresh = await lockAppRow(tx, appId);
			if (!fresh) return false;
			const lease = runLeaseState(leaseView(fresh));
			const expectedHolder = {
				mode: "build",
				runId,
				nonce: holderNonce,
			} as const;
			if (
				!exactRunHolderMatches(lease.holderIdentity, expectedHolder) ||
				!lease.buildFailureWriteOwned(runId)
			) {
				return false;
			}
			const result = await tx
				.updateTable("apps")
				.set({ status: "error", error_type: errorType })
				.where("id", "=", appId)
				.where(expectedRunHolderPredicate(expectedHolder))
				.executeTakeFirst();
			return updatedExactlyOne(result);
		});
	} catch (err) {
		log.error("[failApp] write failed", err, { appId, runId });
		return false;
	}
}

export type RecoverAppStatusOutcome =
	| { readonly kind: "recovered" }
	| { readonly kind: "already_complete" }
	| { readonly kind: "not_found" }
	| { readonly kind: "empty_blueprint" }
	| {
			readonly kind: "holder_token_required" | "holder_token_mismatch";
			readonly holder: RunHolderIdentity;
	  }
	| { readonly kind: "holder_state_changed" };

/**
 * Operator-only status recovery with a locked exact-holder compare-and-set.
 *
 * A free app may be repaired without a holder token. A present holder may be
 * touched only when the operator supplied its exact `(mode, runId, nonce)`
 * capability;
 * corrupt/null identities are therefore intentionally not recoverable here.
 * The SQL predicate repeats that proof on the write itself, so a future
 * refactor that weakens the locking pre-read still cannot release a successor.
 * Edit recovery repairs status/error only and leaves the proven live lock and
 * marker in place. Build recovery's status transition releases that exact
 * build and settles its reservation as a kept charge, matching clean build
 * completion rather than stranding an unsettled debit behind no holder.
 */
export async function recoverAppStatus(
	appId: string,
	expectedHolder: ExactRunHolderIdentity | null,
): Promise<RecoverAppStatusOutcome> {
	return await withAppTx(async (tx) => {
		/* Lifecycle lock order: operator recovery can create/release a live
		 * holder, so the holder's actor gate comes first. */
		await lockActorGenerationGateForAppHolder(tx, appId);
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) return { kind: "not_found" };
		const lease = runLeaseState(leaseView(fresh));
		const recoveringBuildHolder = lease.holderIdentity?.mode === "build";
		let holderPredicate: RawBuilder<boolean>;
		if (lease.holderIdentity !== null) {
			if (expectedHolder === null) {
				return {
					kind: "holder_token_required",
					holder: lease.holderIdentity,
				};
			}
			if (!exactRunHolderMatches(lease.holderIdentity, expectedHolder)) {
				return {
					kind: "holder_token_mismatch",
					holder: lease.holderIdentity,
				};
			}
			holderPredicate = expectedRunHolderPredicate(expectedHolder);
		} else if (expectedHolder !== null) {
			return { kind: "holder_state_changed" };
		} else {
			holderPredicate = noRunHolderPredicate();
		}
		if (fresh.module_count === 0) return { kind: "empty_blueprint" };
		if (fresh.status === "complete" && !fresh.error_type) {
			return { kind: "already_complete" };
		}

		const result = await tx
			.updateTable("apps")
			.set({
				status: "complete",
				error_type: null,
				updated_at: new Date(),
				// A build holder owns the reservation outcome. Declaring that build
				// usable must keep its charge just like completeAndSettleRun; leaving
				// the marker unsettled would strand a debit behind an absent holder.
				...(recoveringBuildHolder && { res_settled: true }),
			})
			.where("id", "=", appId)
			.where(holderPredicate)
			.executeTakeFirst();
		return updatedExactlyOne(result)
			? { kind: "recovered" }
			: { kind: "holder_state_changed" };
	});
}

/**
 * Set or clear a run's `awaiting_input` pause flag. The exact `runId` is
 * re-checked through the one liveness reader while the app row is locked, so a
 * stale drain cannot pause a replacement holder and a late clear cannot unpause
 * it. Clearing ALSO re-arms `updated_at` — the flag (not a fresh timestamp) is
 * what spared a paused BUILD from staleness, so removing it must hand the
 * resuming build a fresh window; the SET path must NOT bump the clock. The
 * route AWAITS the pause SET (durably recorded before the response resolves).
 * Production resume clears through `reacquireLease`; the clear arm remains for
 * exact-holder repair/tests. The outcome distinguishes a replacement holder
 * (`"superseded"`) from a fully released/reaped run (`"released"`), and
 * infrastructure errors throw so callers never mistake an unknown write for a
 * durable pause. Project scope + fresh edit authorization are checked after the
 * app lock, matching resume admission: even a no-mutation question turn cannot
 * park a run after its actor loses access or its app moves Projects.
 */
export async function setAwaitingInput(
	appId: string,
	runId: string,
	holderNonce: string,
	mode: "build" | "edit",
	awaiting: boolean,
	actorUserId: string,
	expectedProjectId: string,
): Promise<ReacquireOutcome> {
	return await withAppTx(async (tx) => {
		/* Lifecycle lock order: the pausing actor's gate first (pause/unpause
		 * is a holder transition). */
		await lockActorGenerationGate(tx, actorUserId);
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) return "released";
		assertExpectedAppProject(fresh, expectedProjectId);
		await assertAppCapabilityInTransaction(
			tx,
			fresh,
			actorUserId,
			"edit",
			"You no longer have edit access to this app's Project.",
		);
		const lease = runLeaseState(leaseView(fresh));
		const expectedHolder = { mode, runId, nonce: holderNonce } as const;
		if (!exactRunHolderMatches(lease.holderIdentity, expectedHolder)) {
			return lease.present ? "superseded" : "released";
		}
		const result = await tx
			.updateTable("apps")
			.set(
				awaiting
					? { awaiting_input: true }
					: { awaiting_input: false, updated_at: new Date() },
			)
			.where("id", "=", appId)
			.where(expectedRunHolderPredicate(expectedHolder))
			.executeTakeFirst();
		return updatedExactlyOne(result) ? "owned" : "superseded";
	});
}

/**
 * Reap a stale `generating` app: refund its stranded credit reservation +
 * flip it to `error` in one transaction with the staleness RE-VALIDATED
 * inside it (`refundStaleGeneration`) — so a fresh build that re-claimed
 * between the scan and the reap reads live and the reap no-ops. Idempotent;
 * fire-and-forget at the scan call sites and AWAITED from the claim's
 * conflict nudge.
 */
export async function reapStaleGenerating(
	appId: string,
	expectedIdentity: ExactRunHolderIdentity,
): Promise<void> {
	try {
		if (expectedIdentity.mode !== "build") return;
		await reapStaleRun(appId, expectedIdentity);
	} catch (err) {
		log.error("[reapStaleGenerating] stale-build reap failed", err, { appId });
	}
}

/**
 * Reap a stranded EDIT reservation: refund an unsettled hold whose run never
 * reached a clean completion, releasing the lapsed `run_lock` in the same
 * commit, WITHOUT flipping status. The wrapper rejects a build-mode target;
 * `refundStaleReservation` re-validates the concrete identity and the whole
 * staleness guard inside its transaction.
 */
export async function reapStaleReservation(
	appId: string,
	expectedIdentity: ExactRunHolderIdentity,
): Promise<void> {
	try {
		if (expectedIdentity.mode !== "edit") return;
		await reapStaleRun(appId, expectedIdentity);
	} catch (err) {
		log.error("[reapStaleReservation] reservation refund failed", err, {
			appId,
		});
	}
}

/**
 * Result-bearing canonical reaper for callers that must prove convergence.
 * Storage failures propagate and a stale identity returns `state_changed`, so
 * neither can be mistaken for a successful release. The credit writers lock
 * the authority row and re-prove the exact holder plus staleness themselves.
 */
export async function reapStaleRun(
	appId: string,
	expectedIdentity: ExactRunHolderIdentity,
): Promise<StaleRunReapOutcome> {
	return expectedIdentity.mode === "build"
		? refundStaleGeneration(appId, expectedIdentity)
		: refundStaleReservation(appId, expectedIdentity);
}

/**
 * Project-move spelling retained at that boundary; it delegates to the one
 * result-bearing exact-holder reaper above.
 */
export async function normalizeReapableRunForProjectMove(
	appId: string,
	expectedIdentity: ExactRunHolderIdentity,
): Promise<StaleRunReapOutcome> {
	return reapStaleRun(appId, expectedIdentity);
}

// ── Soft delete / restore ───────────────────────────────────────────

/**
 * Soft-delete an app: record `deleted_at` + the recovery deadline. Status is
 * intentionally untouched — lifecycle status and existence are independent
 * axes. Throws on a missing row (matching the update-a-ghost posture).
 * Returns the ISO `recoverable_until` so callers surface the deadline.
 */
export async function softDeleteApp(
	appId: string,
	actorUserId: string,
): Promise<string> {
	const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
	const now = new Date();
	const recoverableUntil = new Date(now.getTime() + RETENTION_MS);
	await withAppTx(async (tx) => {
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) {
			throw new CommitReauthError("App not found.");
		}
		await assertAppCapabilityInTransaction(
			tx,
			fresh,
			actorUserId,
			"delete",
			"You no longer have permission to delete this app.",
		);
		await tx
			.updateTable("apps")
			.set({ deleted_at: now, recoverable_until: recoverableUntil })
			.where("id", "=", appId)
			.execute();
	});
	return recoverableUntil.toISOString();
}

/** Restore a soft-deleted app — clears both soft-delete fields as a pair;
 *  status untouched; `updated_at` deliberately not bumped. */
export async function restoreApp(
	appId: string,
	actorUserId: string,
): Promise<void> {
	await withAppTx(async (tx) => {
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) {
			throw new CommitReauthError("App not found.");
		}
		await assertAppCapabilityInTransaction(
			tx,
			fresh,
			actorUserId,
			"delete",
			"You no longer have permission to restore this app.",
		);
		await tx
			.updateTable("apps")
			.set({ deleted_at: null, recoverable_until: null })
			.where("id", "=", appId)
			.execute();
	});
}

// ── Loads ───────────────────────────────────────────────────────────

/**
 * Load a single app by ID — the row plus its assembled blueprint. Returns
 * null if not found. Callers that serve user-facing data must authorize via
 * `resolveAppAccess` — the table doesn't scope by user.
 */
export async function loadApp(appId: string): Promise<AppDoc | null> {
	return withAppTx((tx) => loadAppInTransaction(tx, appId));
}

/**
 * Load one strict app snapshot for a read-only inspector.
 *
 * Production scan identities intentionally have no row-lock privileges. A
 * repeatable-read, read-only transaction gives the root row, entity rows, and
 * lookup definitions one consistent snapshot without asking PostgreSQL for a
 * `FOR SHARE` lock. Interactive/user-facing loads keep using {@link loadApp}
 * and its writer-coordinated lock boundary.
 */
export async function loadAppForInspection(
	appId: string,
): Promise<AppDoc | null> {
	return loadAppForReadOnlyInspection(appId, "strict");
}

async function loadAppForReadOnlyInspection(
	appId: string,
	admission: "strict" | "schema",
): Promise<AppDoc | null> {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const row = (await tx
				.selectFrom("apps")
				.select(PERSISTED_BLUEPRINT_APP_COLUMNS)
				.select(
					sql<string | null>`${sql.ref("apps.case_types")}::text`.as(
						"case_types_text",
					),
				)
				.where("id", "=", appId)
				.executeTakeFirst()) as PersistedBlueprintAppRow | undefined;
			if (row === undefined) return null;
			return admission === "strict"
				? (await loadStrictAppSnapshotFromRowInTransaction(tx, row)).app
				: (await loadSchemaAdmittedAppSnapshotFromRowInTransaction(tx, row))
						.app;
		});
}

/**
 * Load one schema-admitted snapshot for a read-only migration inventory.
 *
 * Unlike {@link loadAppForInspection}, this deliberately does not apply the
 * current absolute commit gate: a scanner for newly-invalid historical state
 * must be able to name that state before any repair is designed. Never use
 * this function to serve an app or authorize an edit.
 */
export async function loadSchemaAdmittedAppForInspection(
	appId: string,
): Promise<AppDoc | null> {
	return loadAppForReadOnlyInspection(appId, "schema");
}

/** Whoever currently HOLDS the app's run window — see {@link loadAppHolder}.
 *  `userId` is undefined when no holder could be resolved. */
export interface AppHolder {
	name: string;
	userId: string | undefined;
}

/**
 * Resolve whoever currently HOLDS the app's run window, for the
 * serialize-with-wait "busy" status and the superseded-resume bail. The edit
 * lock's actor wins when both are present. `userId` lets the route tell a
 * requester blocked by their OWN other request the truth ("your previous
 * request") instead of naming them to themselves; best-effort `"someone"`
 * name fallback.
 */
export async function loadAppHolder(appId: string): Promise<AppHolder> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("apps")
		.select(["lock_actor_user_id", "res_user_id", "owner"])
		.where("id", "=", appId)
		.executeTakeFirst();
	if (!row) return { name: "someone", userId: undefined };
	const holderId = row.lock_actor_user_id ?? row.res_user_id ?? row.owner;
	if (!holderId) return { name: "someone", userId: undefined };
	try {
		const authDb = await getAuthDb();
		const user = await authDb
			.selectFrom("auth_user")
			.select(["name"])
			.where("id", "=", holderId)
			.executeTakeFirst();
		return { name: user?.name || "someone", userId: holderId };
	} catch (err) {
		log.error("[loadAppHolder] auth_user lookup failed", err, { appId });
		return { name: "someone", userId: holderId };
	}
}

export type AppProjectLookup =
	| { readonly kind: "found"; readonly projectId: string }
	| { readonly kind: "not-found" };

/**
 * Load just the owning Project id — the lightweight authorization read.
 *
 * Missing-app state is explicit rather than overloaded onto a nullable Project:
 * every persisted app has exactly one Project.
 */
export async function loadAppProjectId(
	appId: string,
): Promise<AppProjectLookup> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("apps")
		.select("project_id")
		.where("id", "=", appId)
		.executeTakeFirst();
	return row === undefined
		? { kind: "not-found" }
		: { kind: "found", projectId: row.project_id };
}

// ── Listing ─────────────────────────────────────────────────────────

const SEARCH_FETCH_BUFFER = 90;
const FUSE_THRESHOLD = 0.4;

function encodeAppsCursor(cursor: ListAppsCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeAppsCursor(encoded: string): ListAppsCursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		throw new Error("Invalid pagination cursor (malformed encoding).");
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("Invalid pagination cursor (not an object).");
	}
	const obj = parsed as Record<string, unknown>;
	const kind = obj.kind;
	const id = obj.id;
	if (typeof id !== "string") {
		throw new Error("Invalid pagination cursor (missing id).");
	}
	if (kind === "updated_desc" || kind === "updated_asc") {
		const updatedAt = obj.updated_at;
		if (typeof updatedAt !== "string") {
			throw new Error(`Invalid pagination cursor (${kind} payload).`);
		}
		return { kind, updated_at: updatedAt, id };
	}
	if (kind === "name_asc" || kind === "name_desc") {
		const nameLower = obj.name_lower;
		if (typeof nameLower !== "string") {
			throw new Error(`Invalid pagination cursor (${kind} payload).`);
		}
		return { kind, name_lower: nameLower, id };
	}
	throw new Error(`Invalid pagination cursor (unknown kind: ${String(kind)}).`);
}

function cursorFor(
	summary: AppSummary,
	nameLower: string,
	sort: AppsSortOrder,
): string {
	switch (sort) {
		case "updated_desc":
		case "updated_asc":
			return encodeAppsCursor({
				kind: sort,
				updated_at: summary.updated_at,
				id: summary.id,
			});
		case "name_asc":
		case "name_desc":
			return encodeAppsCursor({
				kind: sort,
				name_lower: nameLower,
				id: summary.id,
			});
	}
}

/** The summary projection + the scan-side reapers: a stale build reads as
 *  `error` immediately (the reap settles asynchronously), and a stranded edit
 *  hold fires the refund-only reaper without changing the row shown. */
function projectAppSummary(
	row: AppRowWithoutCaseTypes,
	now: number,
): AppSummary {
	const lease = runLeaseState(leaseView(row), now);
	const isStale = lease.reapableStaleBuild;
	const exactIdentity = toExactRunHolderIdentity(lease.holderIdentity);
	if (isStale && exactIdentity?.mode === "build") {
		void reapStaleGenerating(row.id, exactIdentity);
	}
	if (lease.reapableStrandedEdit && exactIdentity?.mode === "edit") {
		void reapStaleReservation(row.id, exactIdentity);
	}
	return {
		id: row.id,
		app_name: row.app_name,
		connect_type: row.connect_type,
		module_count: row.module_count,
		form_count: row.form_count,
		status: isStale ? "error" : parsePersistedAppLifecycleStatus(row.status),
		error_type: isStale ? "internal" : row.error_type,
		logo: row.logo === null ? null : asMediaAssetId(row.logo),
		created_at: row.created_at.toISOString(),
		updated_at: row.updated_at.toISOString(),
	};
}

/**
 * Paginate apps by scope (Project tenancy or creator), sorted by last
 * modified or name — summary columns only, the blueprint is never assembled.
 * `(sort_field, id)` is the stable composite key the cursor resumes on;
 * soft-deletes are filtered in SQL so a full page genuinely means "maybe
 * more".
 */
async function queryAppsByScope(
	scopeField: "owner" | "project_id",
	scopeValue: string | readonly string[],
	options: ListAppsOptions,
): Promise<ListAppsResult> {
	const { limit, sort, status, cursor } = options;
	const db = await getAppDb();
	let query = db
		.selectFrom("apps")
		.select(PERSISTED_BLUEPRINT_APP_COLUMNS)
		.where("deleted_at", "is", null);
	query = Array.isArray(scopeValue)
		? query.where(scopeField, "in", scopeValue as string[])
		: query.where(scopeField, "=", scopeValue as string);
	if (status) {
		query = query.where("status", "=", status);
	}
	switch (sort) {
		case "updated_desc":
			query = query.orderBy("updated_at", "desc").orderBy("id", "asc");
			break;
		case "updated_asc":
			query = query.orderBy("updated_at", "asc").orderBy("id", "asc");
			break;
		case "name_asc":
			query = query.orderBy("app_name_lower", "asc").orderBy("id", "asc");
			break;
		case "name_desc":
			query = query.orderBy("app_name_lower", "desc").orderBy("id", "asc");
			break;
	}
	if (cursor) {
		const decoded = decodeAppsCursor(cursor);
		if (decoded.kind !== sort) {
			throw new Error(
				`Cursor was minted for sort="${decoded.kind}" but this call uses sort="${sort}".`,
			);
		}
		/* Resume strictly AFTER `(sort_field, id)` in the composite order. The
		 * id tiebreak is ascending on every sort, so "after" is: primary field
		 * past the boundary, OR equal primary and id greater. */
		if (decoded.kind === "updated_desc") {
			const ts = new Date(decoded.updated_at);
			query = query.where((eb) =>
				eb.or([
					eb("updated_at", "<", ts),
					eb.and([eb("updated_at", "=", ts), eb("id", ">", decoded.id)]),
				]),
			);
		} else if (decoded.kind === "updated_asc") {
			const ts = new Date(decoded.updated_at);
			query = query.where((eb) =>
				eb.or([
					eb("updated_at", ">", ts),
					eb.and([eb("updated_at", "=", ts), eb("id", ">", decoded.id)]),
				]),
			);
		} else if (decoded.kind === "name_asc") {
			query = query.where((eb) =>
				eb.or([
					eb("app_name_lower", ">", decoded.name_lower),
					eb.and([
						eb("app_name_lower", "=", decoded.name_lower),
						eb("id", ">", decoded.id),
					]),
				]),
			);
		} else {
			query = query.where((eb) =>
				eb.or([
					eb("app_name_lower", "<", decoded.name_lower),
					eb.and([
						eb("app_name_lower", "=", decoded.name_lower),
						eb("id", ">", decoded.id),
					]),
				]),
			);
		}
	}
	const rows = (await query.limit(limit).execute()) as AppRowWithoutCaseTypes[];
	const now = Date.now();
	const apps = rows.map((row) => projectAppSummary(row, now));
	const last = rows[rows.length - 1];
	const nextCursor =
		rows.length === limit && last
			? cursorFor(apps[apps.length - 1], last.app_name_lower, sort)
			: undefined;
	return { apps, nextCursor };
}

/** List a Project's live apps — the tenancy listing (home page, /api/apps, MCP). */
export function listApps(
	projectId: string,
	options: ListAppsOptions,
): Promise<ListAppsResult> {
	return queryAppsByScope("project_id", projectId, options);
}

/** List a user's OWN (created) apps — admin inspection + the media-deletion
 *  reference scan, creator-scoped rather than tenancy-scoped. */
export function listAppsByOwner(
	owner: string,
	options: ListAppsOptions,
): Promise<ListAppsResult> {
	return queryAppsByScope("owner", owner, options);
}

/**
 * List apps across SEVERAL Projects in one scan — the headless MCP
 * enumeration scope (every Project the caller is a member of). An empty list
 * returns an empty page without a query.
 */
export function listAppsAcrossProjects(
	projectIds: readonly string[],
	options: ListAppsOptions,
): Promise<ListAppsResult> {
	if (projectIds.length === 0) return Promise.resolve({ apps: [] });
	return queryAppsByScope("project_id", projectIds, options);
}

/** Fuzzy-search a single Project's apps by name — the tenancy search. */
export function searchApps(
	projectId: string,
	options: SearchAppsOptions,
): Promise<SearchAppsResult> {
	return rankSearchOverPage((scan) => listApps(projectId, scan), options);
}

/** Fuzzy-search across every Project the caller is a member of — the
 *  headless MCP search scope. */
export function searchAppsAcrossProjects(
	projectIds: readonly string[],
	options: SearchAppsOptions,
): Promise<SearchAppsResult> {
	return rankSearchOverPage(
		(scan) => listAppsAcrossProjects(projectIds, scan),
		options,
	);
}

/**
 * The shared search core: over-fetch one scan page (newest-first — best
 * average-case for the dominant "find my recent X" intent), rank with Fuse
 * (anywhere-in-string fuzzy matching), take `limit`, pass the scan cursor
 * through (if the scan had more to enumerate, there may be more matches).
 */
function rankSearchOverPage(
	scanPage: (scan: ListAppsOptions) => Promise<ListAppsResult>,
	options: SearchAppsOptions,
): Promise<SearchAppsResult> {
	const { query, limit, status, cursor } = options;
	return scanPage({
		limit: limit + SEARCH_FETCH_BUFFER,
		sort: "updated_desc",
		status,
		cursor,
	}).then((page) => {
		const fuse = new Fuse(page.apps, {
			keys: ["app_name"],
			threshold: FUSE_THRESHOLD,
			ignoreLocation: true,
			includeScore: true,
		});
		const matches = fuse
			.search(query)
			.slice(0, limit)
			.map((result) => result.item);
		return { apps: matches, nextCursor: page.nextCursor };
	});
}

// ── Trash query ────────────────────────────────────────────────────

/** Options consumed by `listDeletedApps`. */
export interface ListDeletedAppsOptions {
	/** Max rows. The 30-day retention window bounds the trash, so one page
	 *  typically fits it — no cursor is exposed yet. */
	limit: number;
}

/** Shape returned by `listDeletedApps`. */
export interface ListDeletedAppsResult {
	apps: DeletedAppSummary[];
}

/**
 * List a Project's soft-deleted apps still within the recovery window,
 * most-recently-deleted first. Past-window tombstones persist on disk but
 * are filtered out — the trash is a recovery surface, not an archive.
 */
export async function listDeletedApps(
	projectId: string,
	options: ListDeletedAppsOptions,
): Promise<ListDeletedAppsResult> {
	const db = await getAppDb();
	const rows = (await db
		.selectFrom("apps")
		.select(PERSISTED_BLUEPRINT_APP_COLUMNS)
		.where("project_id", "=", projectId)
		.where("deleted_at", "is not", null)
		.orderBy("deleted_at", "desc")
		.orderBy("id", "asc")
		.limit(options.limit)
		.execute()) as AppRowWithoutCaseTypes[];
	const now = Date.now();
	const apps: DeletedAppSummary[] = [];
	for (const row of rows) {
		const recoverableUntil = row.recoverable_until;
		if (!recoverableUntil || recoverableUntil.getTime() <= now) continue;
		const deletedAt = row.deleted_at;
		if (!deletedAt) continue;
		apps.push({
			id: row.id,
			app_name: row.app_name,
			connect_type: row.connect_type,
			module_count: row.module_count,
			form_count: row.form_count,
			// Soft-delete is the existence axis; lifecycle status remains true.
			status: parsePersistedAppLifecycleStatus(row.status),
			error_type: row.error_type,
			logo: row.logo === null ? null : asMediaAssetId(row.logo),
			created_at: row.created_at.toISOString(),
			updated_at: row.updated_at.toISOString(),
			deleted_at: deletedAt.toISOString(),
			recoverable_until: recoverableUntil.toISOString(),
		});
	}
	return { apps };
}
