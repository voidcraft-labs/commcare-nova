/**
 * The canonical commit kernel — the ONE transactional service behind every
 * guarded Blueprint write.
 *
 * `commitCanonicalBatch` is the read-evaluate-write every interactive mutation
 * path (chat, MCP, auto-save) shares, promoted out of `apps.ts` so that
 * server-owned callers can compose transaction hooks without going through the
 * public wrapper. The public entry points remain `apps.ts::commitGuardedBatch`
 * (ordinary callers) and `applyBlueprintChange` (case-schema-coupled batches);
 * both delegate here. Nothing outside `lib/db` and the server-owned commit
 * hosts may import this module directly.
 *
 * The kernel owns, in one app-locked transaction: the app-row lock, the
 * `(app_id, batch_id)` dedup latch, the expected-Project check, fresh Project
 * membership reauthorization, the exact chat-holder compare, strict fresh
 * app/entity assembly, the organization-revision fence, stale-target
 * rejection, one candidate preparation on the fresh doc, lookup target union
 * locks + fresh lookup verdict, the absolute whole-document gate, exact media
 * reference admission, organization cross-store commit integrity, the
 * `beforeWrite` hook seam (case-store Phase A and future server-owned
 * sidecars), entity diff + app scalar/sequence update + exact reference
 * edges, one admitted `app_changes` row, and the transactional NOTIFY.
 *
 * The hook seam (`CanonicalCommitTransactionHooks`) is deliberately narrow and
 * server-owned: hooks run inside the same retryable transaction and must be
 * deterministic, idempotent, and free of network/object-store effects. They
 * cannot alter the candidate Blueprint or bypass the gate. (Typed sidecar
 * variants such as the design change-set receipt extend this seam.)
 *
 * This module also owns the shared transaction plumbing every locked app
 * protocol composes: the strict persisted-app admission (`loadAppInTransaction`
 * / `loadStrictAppSnapshotFromRowInTransaction`), the app-row lock, the exact
 * media-reference projection, the authoritative lookup context, and the
 * membership/Project assertions. `apps.ts` imports these rather than the
 * reverse, so the dependency arrow points one way: apps → kernel.
 */

import { type Selectable, sql, type Transaction } from "kysely";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import { isBuiltinIconRef } from "@/lib/domain/builtinIcons";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { applyOrganizationCommitIntegrity } from "@/lib/organization/commitIntegrity";
import { parseOrganizationRevision } from "@/lib/organization/schema";
import type { OrganizationRevision } from "@/lib/organization/types";
import {
	nextPersistedSequence,
	safePersistedSequence,
} from "@/lib/utils/persistedSequence";
import type { CasePropertyRenamePlan } from "../doc/casePropertyRenames";
import {
	describeCommitFindings,
	evaluatePreparedMutationCandidate,
	mutationCommitVerdict,
	prepareMutationCandidate,
} from "../doc/commitVerdicts";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "../doc/fieldParent";
import {
	extractLookupReferenceTargets,
	type LookupReferenceTargetSet,
	type LookupValidationContext,
	unionLookupReferenceTargetSets,
} from "../doc/lookupReferences";
import {
	type AdmittedMutationBatch,
	encodeAdmittedMutationEnvelope,
} from "../doc/mutationAdmission";
import { buildReferenceIndex } from "../doc/referenceIndex";
import type {
	BlueprintDoc,
	PersistableDoc,
	PersistedBlueprint,
} from "../domain/blueprint";
import { asWalkableDoc, walkAuthoredAssetRefs } from "../domain/mediaRefs";
import { asMediaAssetId } from "../domain/multimedia";
import { diffBlueprints } from "./blueprintRows";
import {
	type CanonicalCommitSidecar,
	executeCanonicalCommitSidecars,
} from "./canonicalCommitSidecars";
import {
	AppProjectChangedError,
	appChangeFingerprintMatches,
	BlueprintCommitRejectedError,
	CommitReauthError,
	MutationBatchIdCollisionError,
	mutationTargetsInvalid,
	RunHolderLostError,
} from "./commitGuard";
import { leaseView, rowReservation, rowRunLock } from "./leaseView";
import {
	LookupReferenceWriteError,
	lockLookupTablesForReferenceWrite,
	replaceLookupReferenceEdges,
} from "./lookupReferenceEdges";
import {
	deleteMediaReferenceEdges,
	insertMediaReferenceEdges,
	lockAndValidateMediaReferences,
	MediaReferenceProjectionError,
	type MediaReferenceRequirement,
} from "./mediaAssets";
import {
	assemblePersistedBlueprintJsonText,
	type PersistedEntityRowText,
	parsePersistedMutationBatchText,
} from "./persistedJson";
import {
	type AppDatabase,
	type AppsTable,
	notifyAppStream,
	withAppTx,
} from "./pg";
import { projectRoleForInTransaction } from "./projectMembership";
import {
	type ExactRunHolderIdentity,
	exactRunHolderMatches,
	expectedRunHolderPredicate,
	updatedExactlyOne,
} from "./runHolderWrites";
import { editLeaseDeadlineMs, runLeaseState } from "./runLiveness";
import {
	type AppDoc,
	type BlueprintMutationAppChangeKind,
	type ClientAppChangeKind,
	parsePersistedAppLifecycleStatus,
} from "./types";
import { hasUnfinishedMaterializedDesignInTransaction } from "./unfinishedMaterializedDesign";

// ── Holder capability ──────────────────────────────────────────────

/**
 * Exact holder authority carried only by a chat Solutions Architect run.
 *
 * `runId` on a committed batch is attribution: MCP also stamps one, but an MCP
 * call does not own the app's chat build/edit lease. This separate capability
 * is what authorizes a chat run to keep mutating after its claim. The literal
 * source tag prevents a plain attribution object from being passed by accident.
 */
export interface ChatRunHolderCapability extends ExactRunHolderIdentity {
	readonly source: "chat";
}

// ── Row projections ────────────────────────────────────────────────

type AppRow = Selectable<AppsTable>;

export type PersistedBlueprintAppRow = Omit<AppRow, "case_types"> & {
	readonly case_types_text: string | null;
};

/**
 * Complete app-row projection for Blueprint readers. `case_types` is
 * deliberately absent: selecting it even beside `case_types::text` would let
 * pg eagerly parse and numerically alias the discarded JSONB value.
 */
export const PERSISTED_BLUEPRINT_APP_COLUMNS = [
	"id",
	"owner",
	"project_id",
	"app_name",
	"app_name_lower",
	"connect_type",
	"logo",
	"module_count",
	"form_count",
	"mutation_seq",
	"status",
	"awaiting_input",
	"error_type",
	"deleted_at",
	"recoverable_until",
	"run_id",
	"res_period",
	"res_reserved",
	"res_settled",
	"res_user_id",
	"res_run_id",
	"lock_run_id",
	"lock_actor_user_id",
	"lock_expire_at",
	"run_holder_nonce",
	"created_at",
	"updated_at",
] as const satisfies readonly (keyof AppsTable)[];

/** Project one already-admitted persisted blueprint into the full app record. */
export function rowToAppDoc(
	row: PersistedBlueprintAppRow,
	blueprint: PersistableDoc,
): AppDoc {
	return {
		owner: row.owner,
		project_id: row.project_id,
		app_name: row.app_name,
		blueprint,
		mutation_seq: safePersistedSequence(
			row.mutation_seq,
			`apps.mutation_seq for app ${row.id}`,
		),
		connect_type: row.connect_type,
		module_count: row.module_count,
		form_count: row.form_count,
		status: parsePersistedAppLifecycleStatus(row.status),
		...(row.awaiting_input && { awaiting_input: true }),
		error_type: row.error_type,
		deleted_at: row.deleted_at?.toISOString() ?? null,
		recoverable_until: row.recoverable_until?.toISOString() ?? null,
		run_id: row.run_id,
		run_holder_nonce: row.run_holder_nonce,
		...(rowReservation(row) && { reservation: rowReservation(row) }),
		...(rowRunLock(row) && { run_lock: rowRunLock(row) }),
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

/** Lock an app row for the duration of the transaction — the per-app
 *  serialization point every run-lifecycle/commit transaction takes first. */
export async function lockAppRow(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<PersistedBlueprintAppRow | undefined> {
	return (await tx
		.selectFrom("apps")
		.select(PERSISTED_BLUEPRINT_APP_COLUMNS)
		.select(
			sql<string | null>`${sql.ref("apps.case_types")}::text`.as(
				"case_types_text",
			),
		)
		.where("id", "=", appId)
		.forUpdate()
		.executeTakeFirst()) as PersistedBlueprintAppRow | undefined;
}

async function loadEntities(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<PersistedEntityRowText[]> {
	const rows = await tx
		.selectFrom("blueprint_entities")
		.select(["uuid", "kind", "parent_uuid", "ordinal"])
		.select(
			sql<string>`${sql.ref("blueprint_entities.data")}::text`.as("data_text"),
		)
		.where("app_id", "=", appId)
		.execute();
	return rows as PersistedEntityRowText[];
}

type StrictAppLoadAfterRootReadHook = (appId: string) => void | Promise<void>;
let strictAppLoadAfterRootReadHook: StrictAppLoadAfterRootReadHook | null =
	null;

/**
 * Deterministic concurrency seam for the torn-read regression. Production
 * never installs this hook; it runs while the app row's share/update lock is
 * held and before entity rows are read.
 */
export function __setStrictAppLoadAfterRootReadHookForTests(
	hook: StrictAppLoadAfterRootReadHook | null,
): void {
	strictAppLoadAfterRootReadHook = hook;
}

export interface StrictAppSnapshot {
	readonly app: AppDoc;
	readonly doc: BlueprintDoc;
	readonly lookupContext: LookupValidationContext;
}

/**
 * The one current persisted-app admission owner.
 *
 * The caller has already read the app row under either its share lock or one
 * repeatable-read snapshot on `tx`. From there this
 * function reads every Blueprint JSONB carrier as exact `::text`, performs
 * strict schema assembly and hydration, reads the referenced Project lookup
 * definitions on the same transaction, and applies the absolute whole-document
 * gate before returning any current state.
 */
export async function loadStrictAppSnapshotFromRowInTransaction(
	tx: Transaction<AppDatabase>,
	row: PersistedBlueprintAppRow,
): Promise<StrictAppSnapshot> {
	await strictAppLoadAfterRootReadHook?.(row.id);
	const entities = await loadEntities(tx, row.id);
	const persisted = assemblePersistedBlueprintJsonText(
		row.id,
		{
			app_name: row.app_name,
			connect_type: row.connect_type,
			case_types_text: row.case_types_text,
			logo: row.logo,
		},
		entities,
	);
	const doc = hydratePersistedBlueprint(persisted);
	const targets = extractLookupReferenceTargets(doc);
	const definitionSnapshot = await readLookupDefinitionsInTransaction(
		tx,
		row.project_id,
		targets.tableIds,
	);
	const lookupContext: LookupValidationContext = {
		kind: "available",
		...definitionSnapshot,
	};
	const verdict = mutationCommitVerdict(doc, [], lookupContext);
	if (!verdict.ok) {
		const codes = [...new Set(verdict.findings.map((finding) => finding.code))]
			.sort()
			.join(",");
		throw new Error(
			`Persisted app ${row.id} fails the absolute commit gate (${codes}).`,
		);
	}
	return {
		app: rowToAppDoc(row, toPersistableDoc(verdict.nextDoc)),
		doc: verdict.nextDoc,
		lookupContext,
	};
}

/**
 * Load one complete app snapshot on an existing app-state transaction.
 *
 * The `FOR SHARE` app-row lock is the snapshot boundary: every authoritative
 * blueprint writer locks this row before changing either its scalar columns or
 * `blueprint_entities`, so the row (including `mutation_seq`) and the assembled
 * blueprint cannot come from different commits. The lock is intentionally held
 * until the caller's surrounding transaction ends. This function performs no
 * authorization; user-facing readers pair it with the transaction-scoped
 * resolver in `appAccess.ts`.
 */
export async function loadAppInTransaction(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<AppDoc | null> {
	const row = (await tx
		.selectFrom("apps")
		.select(PERSISTED_BLUEPRINT_APP_COLUMNS)
		.select(
			sql<string | null>`${sql.ref("apps.case_types")}::text`.as(
				"case_types_text",
			),
		)
		.where("id", "=", appId)
		.forShare()
		.executeTakeFirst()) as PersistedBlueprintAppRow | undefined;
	if (!row) return null;
	return (await loadStrictAppSnapshotFromRowInTransaction(tx, row)).app;
}

/** Extract denormalized list-display fields from a persistable doc. An app name
 *  is non-blank by construction, so `app_name_lower` is a plain lowering of the
 *  same name the list shows. */
export function denormalize(doc: PersistableDoc) {
	const formCount = doc.moduleOrder.reduce(
		(sum, modUuid) => sum + (doc.formOrder[modUuid]?.length ?? 0),
		0,
	);
	return {
		app_name: doc.appName,
		app_name_lower: doc.appName.toLowerCase(),
		connect_type: doc.connectType ?? null,
		case_types: doc.caseTypes === null ? null : JSON.stringify(doc.caseTypes),
		logo: doc.logo ?? null,
		module_count: doc.moduleOrder.length,
		form_count: formCount,
	};
}

// ── Media + lookup + membership admission ──────────────────────────

export function blueprintMediaRequirements(
	doc: BlueprintDoc | PersistableDoc,
): MediaReferenceRequirement[] {
	return [...walkAuthoredAssetRefs(asWalkableDoc(doc))]
		.filter((ref) => !isBuiltinIconRef(ref.assetId))
		.map((ref) => ({
			assetId: asMediaAssetId(ref.assetId),
			expectedKind: ref.slotKind,
		}));
}

/**
 * Rederive and replace one app's complete AUTHORED media projection —
 * Blueprint carriers only. Conversation attachments live in the separate
 * `thread_media_refs` projection, replaced by the thread writers under the
 * same target lock discipline; the two halves never overwrite each other.
 * The caller already owns the app `FOR UPDATE`; that is what keeps every
 * Blueprint carrier stable while this function reads the other rows.
 */
export async function replaceExactMediaReferencesForApp(
	tx: Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		readonly projectId: string;
		readonly candidateDoc?: BlueprintDoc | PersistableDoc;
	},
): Promise<void> {
	let doc = args.candidateDoc;
	if (doc === undefined) {
		const stored = await loadAppInTransaction(tx, args.appId);
		if (stored === null || stored.project_id !== args.projectId) {
			throw new MediaReferenceProjectionError(
				"The app media projection could not be derived from its locked Project.",
			);
		}
		doc = hydratePersistedBlueprint(stored.blueprint);
	}
	const requirements = blueprintMediaRequirements(doc);
	const assetIds = await lockAndValidateMediaReferences(
		tx,
		args.projectId,
		requirements,
	);
	await deleteMediaReferenceEdges(tx, args.appId);
	await insertMediaReferenceEdges(tx, {
		appId: args.appId,
		projectId: args.projectId,
		assetIds,
	});
}

export async function admitExactMediaReferences(
	tx: Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		readonly projectId: string;
		readonly candidateDoc: BlueprintDoc | PersistableDoc;
	},
): Promise<void> {
	try {
		await replaceExactMediaReferencesForApp(tx, args);
	} catch (error) {
		if (error instanceof MediaReferenceProjectionError) {
			throw new BlueprintCommitRejectedError(
				"A media file used by this app is unavailable, outside this Project, not ready, or the wrong kind for its authored slot. Choose it again and retry.",
			);
		}
		throw error;
	}
}

export function hasLookupReferenceTargets(
	targets: LookupReferenceTargetSet,
): boolean {
	return targets.tableIds.length > 0 || targets.columnTargets.length > 0;
}

/**
 * Freeze the exact tables one candidate pair can reference, then read the
 * rows-free definitions against that same transaction snapshot.
 */
export async function lookupContextForAuthoritativeWrite(
	tx: Transaction<AppDatabase>,
	projectId: string,
	targets: LookupReferenceTargetSet,
): Promise<LookupValidationContext> {
	try {
		await lockLookupTablesForReferenceWrite(tx, projectId, targets.tableIds);
	} catch (error) {
		if (
			error instanceof LookupReferenceWriteError &&
			error.code === "unavailable"
		) {
			throw new BlueprintCommitRejectedError(
				"One or more lookup tables used by this app are no longer available in its Project. Remove or replace those references, then try again.",
			);
		}
		throw error;
	}
	const snapshot = await readLookupDefinitionsInTransaction(
		tx,
		projectId,
		targets.tableIds,
	);
	return { kind: "available", ...snapshot };
}

/** Lock and authorize one existing Better Auth membership on this app tx. */
export async function assertProjectCapabilityInTransaction(
	tx: Transaction<AppDatabase>,
	actorUserId: string,
	projectId: string,
	capability: AppCapability,
	message: string,
): Promise<void> {
	const role = await projectRoleForInTransaction(tx, actorUserId, projectId);
	if (role === null || !roleAllowsApp(role, capability)) {
		throw new CommitReauthError(message);
	}
}

/**
 * Authorize an actor against the Project carried by the freshly locked app
 * row, locking the actor's exact membership row before the caller makes any
 * write-side decision.
 */
export async function assertAppCapabilityInTransaction(
	tx: Transaction<AppDatabase>,
	app: Pick<Selectable<AppsTable>, "owner" | "project_id">,
	actorUserId: string,
	capability: AppCapability,
	message: string,
): Promise<void> {
	await assertProjectCapabilityInTransaction(
		tx,
		actorUserId,
		app.project_id,
		capability,
		message,
	);
}

/** Reject a writer whose admitted Project snapshot no longer matches the app. */
export function assertExpectedAppProject(
	app: Pick<Selectable<AppsTable>, "project_id">,
	expectedProjectId: string,
): void {
	if (app.project_id !== expectedProjectId) {
		throw new AppProjectChangedError();
	}
}

// ── Committed-batch write tail ─────────────────────────────────────

export async function writeBlueprintEntityDiff(
	tx: Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		readonly prevDoc: PersistableDoc;
		readonly committedDoc: PersistedBlueprint;
	},
): Promise<void> {
	const { upserts, deletedUuids } = diffBlueprints(
		args.prevDoc,
		args.committedDoc,
	);
	if (deletedUuids.length > 0) {
		await tx
			.deleteFrom("blueprint_entities")
			.where("app_id", "=", args.appId)
			.where("uuid", "in", deletedUuids)
			.execute();
	}
	if (upserts.length > 0) {
		await tx
			.insertInto("blueprint_entities")
			.values(
				upserts.map((r) => ({
					app_id: args.appId,
					uuid: r.uuid,
					kind: r.kind,
					parent_uuid: r.parent_uuid,
					ordinal: r.ordinal,
					data: JSON.stringify(r.data),
				})),
			)
			.onConflict((oc) =>
				oc.columns(["app_id", "uuid"]).doUpdateSet({
					kind: (eb) => eb.ref("excluded.kind"),
					parent_uuid: (eb) => eb.ref("excluded.parent_uuid"),
					ordinal: (eb) => eb.ref("excluded.ordinal"),
					data: (eb) => eb.ref("excluded.data"),
				}),
			)
			.execute();
	}
}

/**
 * The one committed-batch write — the shared tail of every guarded commit.
 * On the caller's transaction (which holds the app row lock): write the
 * entity-row DIFF (only what changed), stamp the scalars + denormalized
 * summary + `mutation_seq` at the caller's LITERAL `seq`, append the
 * PERMANENT `app_changes` entry (whose `UNIQUE (app_id, batch_id)` is
 * the idempotency latch), and poke the stream channel — the NOTIFY delivers
 * on commit, after the rows are visible.
 */
export async function writeCommittedBatch(
	tx: Transaction<AppDatabase>,
	args: {
		appId: string;
		seq: number;
		batchId: string;
		runId?: string;
		prevDoc: PersistableDoc;
		committedDoc: PersistedBlueprint;
		mutations: AdmittedMutationBatch;
		actorUserId: string;
		kind: BlueprintMutationAppChangeKind;
		/** Exact chat holder authority. The conditional app-row write is the final
		 * SQL compare-and-set after every entity/reference preparation step. */
		expectedHolder?: ExactRunHolderIdentity;
		extraAppFields?: Partial<{ lock_expire_at: Date }>;
	},
): Promise<void> {
	await writeBlueprintEntityDiff(tx, args);
	await tx
		.insertInto("app_changes")
		.values({
			app_id: args.appId,
			seq: args.seq,
			batch_id: args.batchId,
			run_id: args.runId ?? null,
			actor_id: args.actorUserId,
			kind: args.kind,
			mutations: encodeAdmittedMutationEnvelope(args.mutations).json,
			from_project_id: null,
			to_project_id: null,
		})
		.execute();
	let appUpdate = tx
		.updateTable("apps")
		.set({
			...denormalize(args.committedDoc),
			mutation_seq: args.seq,
			updated_at: new Date(),
			...(args.runId !== undefined && { run_id: args.runId }),
			...args.extraAppFields,
		})
		.where("id", "=", args.appId);
	if (args.expectedHolder !== undefined) {
		appUpdate = appUpdate.where(
			expectedRunHolderPredicate(args.expectedHolder),
		);
	}
	const appUpdateResult = await appUpdate.executeTakeFirst();
	if (!updatedExactlyOne(appUpdateResult)) {
		if (args.expectedHolder !== undefined) {
			throw new RunHolderLostError("superseded");
		}
		throw new Error(
			`[writeCommittedBatch] app row missing for appId=${args.appId}`,
		);
	}
	await notifyAppStream(tx, args.appId, args.seq);
}

// ── The kernel entry ───────────────────────────────────────────────

/** Arguments for {@link commitCanonicalBatch}. */
export interface CanonicalCommitRequest {
	readonly appId: string;
	/** Client-minted idempotency key; a re-commit of the same id is a no-op. */
	readonly batchId: string;
	/** The SA run that produced the batch (chat/mcp); absent for an autosave. */
	readonly runId?: string;
	/**
	 * Exact chat lease authority, distinct from the attribution `runId` above.
	 * GenerationContext supplies it; MCP deliberately never does.
	 */
	readonly chatRunHolder?: ChatRunHolderCapability;
	readonly mutations: AdmittedMutationBatch;
	/** The acting user — reauth + attribution key, never the tenant. */
	readonly actorUserId: string;
	readonly kind: ClientAppChangeKind;
	/**
	 * Project captured with the caller's admitted blueprint/scope snapshot. A
	 * move before this commit rejects so stale work reloads instead of silently
	 * crossing tenant scope. This is only a scope expectation: fresh
	 * authorization below always runs transactionally.
	 */
	readonly expectedProjectId: string;
	/**
	 * Optional read-set fence for a tool result derived from organization rows.
	 * Checked after the app lock and before a fresh write; dedup replays return
	 * their prior success regardless of later organization changes.
	 */
	readonly expectedOrganizationRevision?: OrganizationRevision;
}

/** Outcome of {@link commitCanonicalBatch}. */
export interface CanonicalCommitReceipt {
	readonly seq: number;
	/** The committed doc, fully hydrated (`fieldParent` + `refIndex`). */
	readonly committedDoc: BlueprintDoc;
	/** True when the `batchId` was already committed (nothing written). */
	readonly deduped: boolean;
}

export interface GuardedBatchBeforeWriteContext {
	readonly tx: Transaction<AppDatabase>;
	readonly freshDoc: BlueprintDoc;
	readonly nextDoc: BlueprintDoc;
	readonly seq: number;
	readonly casePropertyRenamePlan?: CasePropertyRenamePlan;
}

export interface CanonicalCommitTransactionHooks {
	/**
	 * Infrastructure composition seam after fresh locked admission and before
	 * Blueprint/event persistence. Explicit case-property rename uses it to put
	 * row/schema Phase A in the same app-locked transaction. Hooks run inside
	 * the retryable transaction: they must be deterministic, idempotent, and
	 * free of network/object-store effects, and they cannot alter the candidate
	 * Blueprint or bypass the gate. Server-owned callers only.
	 */
	readonly beforeWrite?: (
		context: GuardedBatchBeforeWriteContext,
	) => Promise<void>;
	/**
	 * Closed, typed SQL-only sidecars (`canonicalCommitSidecars.ts`) executed
	 * AFTER the committed-batch write tail, in the same transaction, with the
	 * kernel's authoritative sequence/batch id/candidate after the write tail,
	 * once a lost holder CAS has already aborted. The change-set commit's
	 * `open → committed` flip and receipt ride here. Skipped entirely on a
	 * dedup hit — the original commit ran them.
	 */
	readonly sidecars?: readonly CanonicalCommitSidecar[];
}

export interface CanonicalCommitKernelOptions
	extends CanonicalCommitTransactionHooks {
	/** Absolute executor deadline. The transaction wrapper installs the
	 * matching PostgreSQL transaction timeout so a canonical write cannot
	 * commit after the slice's wall-clock authority expires. */
	readonly deadlineAt?: number;
	/**
	 * Existing transaction used only by infrastructure probes that must exercise
	 * the exact guarded writer and then roll the surrounding transaction back.
	 * Ordinary callers always omit this and retain the retrying transaction plus
	 * same-transaction exact media projection below.
	 */
	readonly transaction?: Transaction<AppDatabase>;
}

/** Postgres unique-violation SQLSTATE — the dedup latch's concurrent-retry arm. */
export function isUniqueViolation(err: unknown): boolean {
	return (err as { code?: unknown })?.code === "23505";
}

/**
 * The unified guarded blueprint commit — the read-evaluate-write every
 * interactive mutation path (chat, MCP, auto-save) shares. Synthetic repairs
 * and the atomic cross-Project move use the parallel locked protocols in
 * `apps.ts`.
 *
 * One transaction: lock the app row (the per-app serialization point); a
 * dedup hit on `(app_id, batch_id)` returns the recorded seq + the current
 * committed doc, writing nothing; lock + reauthorize the actor's exact Project
 * membership against the fresh row (a concurrent MOVE rejects retryably);
 * while an initial build owns the app, reject every caller that does not carry
 * that exact build-holder authority; when chat supplied holder authority,
 * compare its exact mode/run identity before evaluation and again on the final
 * app-row SQL update (MCP's attribution-only run id supplies no authority);
 * re-check media expectations against rows read `FOR SHARE` (a racing delete
 * blocks behind this commit); assemble + hydrate the fresh doc; reject a
 * batch targeting a concurrently-removed entity or one the re-run verdict
 * rejects; lock the union of prior/candidate lookup tables, evaluate against
 * their same-snapshot definitions, replace exact reference edges; advance
 * `mutation_seq` to a LITERAL `fresh + 1`; and {@link writeCommittedBatch}. A
 * concurrent retry of the same batch that
 * races past the dedup read is caught by the UNIQUE latch at insert and
 * converges on the deduped result.
 */
export async function commitCanonicalBatch(
	args: CanonicalCommitRequest,
	internalOptions: CanonicalCommitKernelOptions = {},
): Promise<CanonicalCommitReceipt> {
	const { appId, batchId, runId, mutations, actorUserId, kind } = args;
	if (
		(kind === "chat" &&
			(args.chatRunHolder?.source !== "chat" ||
				runId === undefined ||
				runId !== args.chatRunHolder?.runId)) ||
		(kind !== "chat" && args.chatRunHolder !== undefined)
	) {
		throw new Error(
			"[commitGuardedBatch] chat writes require matching chat holder authority; non-chat writes cannot supply it",
		);
	}

	const commitInTransaction = async (
		tx: Transaction<AppDatabase>,
	): Promise<CanonicalCommitReceipt> => {
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) {
			throw new Error(
				`[commitGuardedBatch] app row missing for appId=${appId}`,
			);
		}
		// Idempotent replay of an already-committed batch — the latch read
		// happens under the app row lock, so it observes every prior commit.
		const latch = await tx
			.selectFrom("app_changes")
			.select(["seq", "actor_id", "kind", "run_id"])
			.select(
				sql<string>`${sql.ref("app_changes.mutations")}::text`.as(
					"mutations_text",
				),
			)
			.where("app_id", "=", appId)
			.where("batch_id", "=", batchId)
			.executeTakeFirst();
		const latchMutations =
			latch === undefined
				? undefined
				: parsePersistedMutationBatchText(
						latch.mutations_text,
						`app_changes.mutations for app ${appId}, sequence ${latch.seq}`,
					);
		if (
			latch !== undefined &&
			!appChangeFingerprintMatches(
				{
					mutations: latchMutations,
					actorUserId: latch.actor_id,
					kind: latch.kind,
					runId: latch.run_id,
				},
				{ mutations, actorUserId, kind, runId },
			)
		) {
			throw new MutationBatchIdCollisionError();
		}
		// Reject a caller admitted against an older Project placement. Explicit
		// rename Phase A shares this transaction, so no case/schema write can
		// escape before this fresh scope check.
		assertExpectedAppProject(fresh, args.expectedProjectId);
		await assertProjectCapabilityInTransaction(
			tx,
			actorUserId,
			fresh.project_id,
			"edit",
			"You no longer have edit access to this app's Project.",
		);
		const lease = runLeaseState(leaseView(fresh));
		if (
			args.chatRunHolder !== undefined &&
			!exactRunHolderMatches(lease.holderIdentity, args.chatRunHolder)
		) {
			throw new RunHolderLostError(lease.present ? "superseded" : "released");
		}
		/* The accepted initial contract and plan stay frozen until authoritative
		 * completion, not merely until the live lease disappears. A failed partial
		 * build is still unfinished after `failApp` changes status to `error`.
		 * Chat construction commits carry the exact live holder; MCP/autosave do
		 * not. */
		if (
			args.chatRunHolder === undefined &&
			(lease.mode === "build" ||
				(await hasUnfinishedMaterializedDesignInTransaction(tx, appId)))
		) {
			throw new BlueprintCommitRejectedError(
				"This app's reviewed initial build has not finished. Wait for it to complete before editing the app.",
			);
		}
		if (mutations.length === 0) {
			throw new BlueprintCommitRejectedError(
				"This change did not contain any edits.",
			);
		}
		const freshSnapshot = await loadStrictAppSnapshotFromRowInTransaction(
			tx,
			fresh,
		);
		const freshPersistable = freshSnapshot.app.blueprint;
		if (latch) {
			const dedupedDoc = freshSnapshot.doc;
			dedupedDoc.refIndex = buildReferenceIndex(dedupedDoc);
			return {
				seq: safePersistedSequence(
					latch.seq,
					`app_changes.seq for app ${appId}`,
				),
				committedDoc: dedupedDoc,
				deduped: true,
			};
		}
		if (args.expectedOrganizationRevision !== undefined) {
			const organizationState = await tx
				.selectFrom("app_organization_state")
				.select("revision")
				.where("app_id", "=", appId)
				.executeTakeFirst();
			const currentOrganizationRevision =
				organizationState === undefined
					? "0"
					: parseOrganizationRevision(organizationState.revision);
			const expectedOrganizationRevision = parseOrganizationRevision(
				args.expectedOrganizationRevision,
			);
			if (currentOrganizationRevision !== expectedOrganizationRevision) {
				throw new BlueprintCommitRejectedError(
					"This app's places changed while the automation was being saved. Retry the automation change so its CommCare HQ setup guide uses the current organization.",
				);
			}
		}
		// Rebuild the fresh doc, reject a concurrent-delete target, re-verdict.
		const freshDoc = freshSnapshot.doc;
		if (mutationTargetsInvalid(freshDoc, mutations)) {
			throw new BlueprintCommitRejectedError(
				"This app changed while you were editing. Something your change " +
					"targeted was removed by someone else. Reload to get the latest " +
					"version, then redo that change.",
			);
		}
		const prepared = prepareMutationCandidate(freshDoc, mutations);
		const previousTargets = extractLookupReferenceTargets(freshDoc);
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
		const seq = nextPersistedSequence(
			fresh.mutation_seq,
			`apps.mutation_seq for app ${appId}`,
		);
		const persistable = toPersistableDoc(verdict.nextDoc);
		await admitExactMediaReferences(tx, {
			appId,
			projectId: fresh.project_id,
			candidateDoc: verdict.nextDoc,
		});
		await applyOrganizationCommitIntegrity(tx, {
			appId,
			previousDoc: freshDoc,
			candidateDoc: verdict.nextDoc,
		});
		await internalOptions.beforeWrite?.({
			tx,
			freshDoc,
			nextDoc: verdict.nextDoc,
			seq,
			...(verdict.prepared.casePropertyRenamePlan !== undefined && {
				casePropertyRenamePlan: verdict.prepared.casePropertyRenamePlan,
			}),
		});
		/* Per-commit EDIT lease refresh — the run-lock analogue of the build's
		 * per-commit `updated_at` stamp. Fires only when THIS commit's run OWNS
		 * the edit lock (through the one liveness reader). */
		const commitLease =
			args.chatRunHolder !== undefined
				? runLeaseState(leaseView(fresh))
				: undefined;
		const ownsEditLock =
			args.chatRunHolder?.mode === "edit" &&
			exactRunHolderMatches(
				commitLease?.holderIdentity ?? null,
				args.chatRunHolder,
			);
		await replaceLookupReferenceEdges(tx, {
			appId,
			projectId: fresh.project_id,
			targets: candidateTargets,
		});
		await writeCommittedBatch(tx, {
			appId,
			seq,
			batchId,
			runId,
			prevDoc: freshPersistable,
			committedDoc: persistable,
			mutations,
			actorUserId,
			kind,
			...(args.chatRunHolder !== undefined && {
				expectedHolder: args.chatRunHolder,
			}),
			...(ownsEditLock && {
				extraAppFields: { lock_expire_at: new Date(editLeaseDeadlineMs()) },
			}),
		});
		/* Typed sidecars run AFTER the committed-batch write, in the same
		 * transaction, after a lost holder CAS has already aborted. */
		if (
			internalOptions.sidecars !== undefined &&
			internalOptions.sidecars.length > 0
		) {
			await executeCanonicalCommitSidecars(tx, {
				appId,
				seq,
				batchId,
				committedSnapshot: persistable,
				sidecars: internalOptions.sidecars,
			});
		}
		return {
			seq,
			committedDoc: verdict.nextDoc,
			deduped: false,
		};
	};
	const commitOnce = (): Promise<CanonicalCommitReceipt> =>
		internalOptions.transaction === undefined
			? withAppTx(commitInTransaction, {
					...(internalOptions.deadlineAt !== undefined && {
						deadlineAt: internalOptions.deadlineAt,
					}),
				})
			: commitInTransaction(internalOptions.transaction);

	let result: CanonicalCommitReceipt;
	try {
		result = await commitOnce();
	} catch (err) {
		// A concurrent commit of the SAME batchId slipped between our latch read
		// and insert — the UNIQUE constraint caught it; converge on the dedup.
		// An externally-owned transaction is already aborted by the violation,
		// so its rollback-only probe must fail instead of attempting a retry.
		if (internalOptions.transaction !== undefined || !isUniqueViolation(err)) {
			throw err;
		}
		result = await commitOnce();
	}

	return result;
}
