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
	type RawBuilder,
	type Selectable,
	sql,
	type Transaction,
	type UpdateResult,
} from "kysely";
import type { ErrorType } from "@/lib/agent";
import { getAuthDb } from "@/lib/auth/db";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import { retenantAppCasesOn } from "@/lib/case-store/retenant";
import type { Database as CaseDatabase } from "@/lib/case-store/sql/database";
import {
	collectThreadAttachmentAssetIds,
	collectThreadAttachments,
	remapThreadAttachmentAssetIds,
} from "@/lib/chat/threadAttachments";
import { isBuiltinIconRef } from "@/lib/domain/builtinIcons";
import { log } from "@/lib/logger";
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
	exportReadinessFindings,
	mutationCommitVerdict,
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
	type LookupReferenceTargetSet,
	type LookupValidationContext,
	unionLookupReferenceTargetSets,
} from "../doc/lookupReferences";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
	encodeAdmittedMutationEnvelope,
} from "../doc/mutationAdmission";
import { buildReferenceIndex } from "../doc/referenceIndex";
import { canonicalAppGenesis } from "../doc/scaffolds";
import type { Mutation } from "../doc/types";
import {
	APP_GENESIS_FALLBACK_NAME,
	type BlueprintDoc,
	type PersistableDoc,
	type PersistedBlueprint,
} from "../domain/blueprint";
import {
	asWalkableDoc,
	collectRealAssetRefs,
	remapAssetRefs,
	walkAuthoredAssetRefs,
} from "../domain/mediaRefs";
import {
	type AssetKind,
	asMediaAssetId,
	type MediaAssetId,
} from "../domain/multimedia";
import type { Uuid } from "../domain/uuid";
import { decomposeBlueprint, diffBlueprints } from "./blueprintRows";
import {
	AppProjectChangedError,
	appChangeFingerprintMatches,
	BlueprintCommitRejectedError,
	CommitReauthError,
	MutationBatchIdCollisionError,
	mutationTargetsInvalid,
	RunHolderLostError,
} from "./commitGuard";
import {
	debitAndBookReservation,
	type Reservation,
	refundStaleGeneration,
	refundStaleReservation,
	type StaleRunReapOutcome,
} from "./credits";
import {
	LEASE_COLUMNS,
	leaseView,
	rowReservation,
	rowRunLock,
} from "./leaseView";
import {
	LookupReferenceWriteError,
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
	type MediaReferenceRequirement,
} from "./mediaAssets";
import {
	deleteMediaAssetMetadataInTransaction,
	MediaAssetStillReferencedError,
} from "./mediaDeletion";
import { getCurrentPeriod } from "./period";
import {
	assemblePersistedBlueprintJsonText,
	type PersistedEntityRowText,
	parsePersistedMutationBatchText,
} from "./persistedJson";
import {
	type AppDatabase,
	type AppsTable,
	getAppDb,
	notifyAppStream,
	notifyPresence,
	withAppTx,
} from "./pg";
import { projectRoleForInTransaction } from "./projectMembership";
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
import {
	type AppDoc,
	type BlueprintMutationAppChangeKind,
	type ClientAppChangeKind,
	parsePersistedAppLifecycleStatus,
} from "./types";

// ── Types ──────────────────────────────────────────────────────────

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
type PersistedBlueprintAppRow = Omit<AppRow, "case_types"> & {
	readonly case_types_text: string | null;
};

/**
 * Complete app-row projection for Blueprint readers. `case_types` is
 * deliberately absent: selecting it even beside `case_types::text` would let
 * pg eagerly parse and numerically alias the discarded JSONB value.
 */
const PERSISTED_BLUEPRINT_APP_COLUMNS = [
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

// ── Row projections ────────────────────────────────────────────────

/** Project one already-admitted persisted blueprint into the full app record. */
function rowToAppDoc(
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
async function lockAppRow(
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

interface StrictAppSnapshot {
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
async function loadStrictAppSnapshotFromRowInTransaction(
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

/** Extract denormalized list-display fields from a persistable doc. An app name
 *  is non-blank by construction, so `app_name_lower` is a plain lowering of the
 *  same name the list shows. */
function denormalize(doc: PersistableDoc) {
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

export interface CandidateThreadMediaProjection {
	readonly threadId: string;
	readonly messages: readonly unknown[];
}

function blueprintMediaRequirements(
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
 * Rederive and replace one app's complete live media projection. The caller
 * already owns the app `FOR UPDATE`; that is what keeps every Blueprint and
 * thread carrier stable while this function reads the other rows.
 */
export async function replaceExactMediaReferencesForApp(
	tx: Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		readonly projectId: string;
		readonly candidateDoc?: BlueprintDoc | PersistableDoc;
		readonly candidateThread?: CandidateThreadMediaProjection;
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
	const threads = await tx
		.selectFrom("threads")
		.select(["thread_id", "messages"])
		.where("app_id", "=", args.appId)
		.orderBy("thread_id")
		.execute();
	let substituted = false;
	for (const thread of threads) {
		const messages =
			args.candidateThread?.threadId === thread.thread_id
				? args.candidateThread.messages
				: thread.messages;
		if (args.candidateThread?.threadId === thread.thread_id) substituted = true;
		for (const attachment of collectThreadAttachments(messages)) {
			requirements.push({
				assetId: attachment.assetId,
				expectedKind: attachment.kind as AssetKind,
			});
		}
	}
	if (args.candidateThread !== undefined && !substituted) {
		for (const attachment of collectThreadAttachments(
			args.candidateThread.messages,
		)) {
			requirements.push({
				assetId: attachment.assetId,
				expectedKind: attachment.kind as AssetKind,
			});
		}
	}
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

async function admitExactMediaReferences(
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

function hasLookupReferenceTargets(targets: LookupReferenceTargetSet): boolean {
	return targets.tableIds.length > 0 || targets.columnTargets.length > 0;
}

/**
 * Freeze the exact tables one candidate pair can reference, then read the
 * rows-free definitions against that same transaction snapshot.
 */
async function lookupContextForAuthoritativeWrite(
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
async function assertProjectCapabilityInTransaction(
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
async function assertAppCapabilityInTransaction(
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
function assertExpectedAppProject(
	app: Pick<Selectable<AppsTable>, "project_id">,
	expectedProjectId: string,
): void {
	if (app.project_id !== expectedProjectId) {
		throw new AppProjectChangedError();
	}
}

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
 * Whether the ACTOR has a live build in progress on ANOTHER app — the
 * cross-app "one build at a time per user" guard.
 *
 * One query unions the two places a run's actor is recorded across a build's
 * life: `owner` (a brand-new build, before the reservation marker exists —
 * `createApp` writes the row first, so the row itself is the lock) and
 * `res_user_id` (a run the actor drives on an app someone else owns). An
 * owner-matched row whose `res_user_id` is a DIFFERENT user is a co-member's
 * run on this user's app — their concurrency, not this user's — so it's
 * skipped; a marker-less owner match (the new-build window) is kept.
 *
 * Standalone callers get the fire-and-forget stale-reap side effect; the
 * claim transaction runs the same scan in-txn via `scanActiveGeneration` and
 * fires the reaps after commit.
 */
export async function hasActiveGeneration(
	actorUserId: string,
	excludeAppId?: string,
): Promise<boolean> {
	const db = await getAppDb();
	const { live, reapable } = await scanActiveGeneration(
		db,
		actorUserId,
		excludeAppId,
	);
	for (const target of reapable) {
		void reapStaleGenerating(target.appId, target.identity);
	}
	return live;
}

/** The scan body, callable inside a transaction (side-effect free — the
 *  caller fires the collected reaps after commit). */
async function scanActiveGeneration(
	db: Pick<Transaction<AppDatabase>, "selectFrom">,
	actorUserId: string,
	excludeAppId?: string,
): Promise<{
	live: boolean;
	reapable: Array<{ appId: string; identity: ExactRunHolderIdentity }>;
}> {
	let query = db
		.selectFrom("apps")
		.select(["id", ...LEASE_COLUMNS])
		.where("deleted_at", "is", null)
		.where("status", "=", "generating")
		.where((eb) =>
			eb.or([
				eb("owner", "=", actorUserId),
				eb("res_user_id", "=", actorUserId),
			]),
		)
		/* Freshest first, so a LIVE build is never paged out of the LIMIT by an
		 * accumulation of stale un-reaped rows. */
		.orderBy("updated_at", "desc")
		.limit(10);
	if (excludeAppId !== undefined) {
		query = query.where("id", "!=", excludeAppId);
	}
	const rows = await query.execute();
	const now = Date.now();
	const reapable: Array<{ appId: string; identity: ExactRunHolderIdentity }> =
		[];
	let live = false;
	for (const row of rows) {
		/* A co-member's run on THIS user's owned app is the co-member's
		 * concurrency, not this user's. A marker-less owner match (the new-build
		 * window) has no run actor yet and is kept. */
		const runActor = row.res_user_id ?? undefined;
		if (runActor !== undefined && runActor !== actorUserId) continue;
		const lease = runLeaseState(leaseView(row as AppRow), now);
		if (lease.live) live = true;
		else if (lease.reapableStaleBuild) {
			const identity = toExactRunHolderIdentity(lease.holderIdentity);
			if (identity !== null) reapable.push({ appId: row.id, identity });
		}
	}
	return { live, reapable };
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

/** Optional lifecycle and naming inputs for `createApp`. */
export interface CreateAppOptions {
	/** Initial name authored by the canonical genesis mutation batch. An omitted
	 *  or whitespace-only value becomes the real persisted name `Untitled`. */
	name?: string;
	/**
	 * Initial lifecycle status. `"generating"` arms the staleness clock (the
	 * chat build's run-liveness marker); `"complete"` is the at-rest default
	 * for every other creation. `"error"` is excluded — a fresh
	 * app has failed at nothing and soft-delete is out-of-band.
	 */
	status?: "generating" | "complete";
	/** Internal chat lifecycle generation. The chat route mints this server-side
	 * before creating a build; non-chat complete app creation leaves it null. */
	runHolderNonce?: string;
}

/** Exact committed sequence-1 state and identities returned by app genesis. */
export interface CreateAppReceipt {
	appId: string;
	baseSeq: 1;
	blueprint: PersistableDoc;
	starter: {
		moduleUuid: Uuid;
		formUuid: Uuid;
		fieldUuid: Uuid;
	};
}

/**
 * Create a new app in its one legal persisted birth state. The canonical name,
 * survey module, form, and field are prepared and admitted before the retryable
 * transaction; the app root, locked lookup verdict, media admission, lookup
 * edges, entities, empty sequence-1 fold-baseline change, and immutable baseline
 * then commit together or not at all.
 */
export async function createApp(
	owner: string,
	projectId: string,
	runId: string,
	opts?: CreateAppOptions,
): Promise<CreateAppReceipt> {
	const appId = crypto.randomUUID();
	const runHolderNonce =
		(opts?.status ?? "generating") === "generating"
			? (opts?.runHolderNonce ?? crypto.randomUUID())
			: null;
	const emptyDoc: BlueprintDoc = {
		appId,
		appName: APP_GENESIS_FALLBACK_NAME,
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
	// Atomic creation is the app-lock exception: a SQL retry may re-run the
	// transaction closure, so UUID minting and the reducer stay outside it. The
	// prepared canonical value is then safe to evaluate repeatedly under the
	// transaction's locked Project lookup definition snapshot.
	const genesis = canonicalAppGenesis(emptyDoc, opts?.name);
	const genesisMutations = admitMutationBatch(genesis.mutations);
	const prepared = prepareMutationCandidate(emptyDoc, genesisMutations);
	const candidateTargets = extractLookupReferenceTargets(prepared.nextDoc);
	const persistable = toPersistableDoc(prepared.nextDoc);
	const denorm = denormalize(persistable);
	await withAppTx(async (tx) => {
		await assertProjectCapabilityInTransaction(
			tx,
			owner,
			projectId,
			"edit",
			"You no longer have edit access to this Project.",
		);
		await tx
			.insertInto("apps")
			.values({
				id: appId,
				owner,
				project_id: projectId,
				...denorm,
				mutation_seq: 1,
				status: opts?.status ?? "generating",
				awaiting_input: false,
				error_type: null,
				deleted_at: null,
				recoverable_until: null,
				run_id: runId,
				run_holder_nonce: runHolderNonce,
			})
			.execute();
		const lookupContext = await lookupContextForAuthoritativeWrite(
			tx,
			projectId,
			candidateTargets,
		);
		const verdict = evaluatePreparedMutationCandidate(prepared, lookupContext);
		if (!verdict.ok) {
			throw new Error(
				`App template is not valid by construction: ${describeCommitFindings(
					verdict.findings,
				)}`,
			);
		}
		const notExportable = exportReadinessFindings(
			verdict.nextDoc,
			lookupContext,
		);
		if (notExportable.length > 0) {
			throw new Error(
				`App genesis must be export-ready, but the canonical starter could not be exported:\n${notExportable
					.map((error) => `- ${error.message}`)
					.join("\n")}`,
			);
		}
		await admitExactMediaReferences(tx, {
			appId,
			projectId,
			candidateDoc: verdict.nextDoc,
		});
		await replaceLookupReferenceEdges(tx, {
			appId,
			projectId,
			targets: candidateTargets,
		});
		const rows = decomposeBlueprint(persistable);
		if (rows.length > 0) {
			await tx
				.insertInto("blueprint_entities")
				.values(
					rows.map((r) => ({
						app_id: appId,
						uuid: r.uuid,
						kind: r.kind,
						parent_uuid: r.parent_uuid,
						ordinal: r.ordinal,
						data: JSON.stringify(r.data),
					})),
				)
				.execute();
		}
		const baselineMutations = admitMutationBatch([]);
		await tx
			.insertInto("app_changes")
			.values({
				app_id: appId,
				seq: 1,
				batch_id: `genesis:${appId}`,
				run_id: runId,
				actor_id: owner,
				kind: "fold-baseline",
				mutations: encodeAdmittedMutationEnvelope(baselineMutations).json,
				from_project_id: null,
				to_project_id: null,
			})
			.execute();
		await sql`SELECT nova_insert_app_change_genesis_fold_baseline(${appId})`.execute(
			tx,
		);
	});
	return {
		appId,
		baseSeq: 1,
		blueprint: persistable,
		starter: {
			moduleUuid: genesis.moduleUuid,
			formUuid: genesis.formUuid,
			fieldUuid: genesis.fieldUuid,
		},
	};
}

// ── Committed-batch writer ──────────────────────────────────────────

async function writeBlueprintEntityDiff(
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
async function writeCommittedBatch(
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

/** Arguments for {@link commitGuardedBatch}. */
export interface CommitGuardedBatchArgs {
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

/** Outcome of {@link commitGuardedBatch}. */
export interface CommitGuardedBatchResult {
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

export interface CommitGuardedBatchTransactionHooks {
	/**
	 * Infrastructure composition seam after fresh locked admission and before
	 * Blueprint/event persistence. Explicit case-property rename uses it to put
	 * row/schema Phase A in the same app-locked transaction.
	 */
	readonly beforeWrite?: (
		context: GuardedBatchBeforeWriteContext,
	) => Promise<void>;
}

interface CommitGuardedBatchInternalOptions
	extends CommitGuardedBatchTransactionHooks {
	/**
	 * Existing transaction used only by infrastructure probes that must exercise
	 * the exact guarded writer and then roll the surrounding transaction back.
	 * Ordinary callers always omit this and retain the retrying transaction plus
	 * same-transaction exact media projection below.
	 */
	readonly transaction?: Transaction<AppDatabase>;
}

/** Postgres unique-violation SQLSTATE — the dedup latch's concurrent-retry arm. */
function isUniqueViolation(err: unknown): boolean {
	return (err as { code?: unknown })?.code === "23505";
}

/**
 * The unified guarded blueprint commit — the read-evaluate-write every
 * interactive mutation path (chat, MCP, auto-save) shares. Synthetic repairs
 * and the atomic cross-Project move use the parallel locked protocols below.
 *
 * One transaction: lock the app row (the per-app serialization point); a
 * dedup hit on `(app_id, batch_id)` returns the recorded seq + the current
 * committed doc, writing nothing; lock + reauthorize the actor's exact Project
 * membership against the fresh row (a concurrent MOVE rejects retryably);
 * when chat supplied holder authority,
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
export async function commitGuardedBatch(
	args: CommitGuardedBatchArgs,
	internalOptions: CommitGuardedBatchInternalOptions = {},
): Promise<CommitGuardedBatchResult> {
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

	type InternalResult = CommitGuardedBatchResult & {
		persistable?: PersistedBlueprint;
	};

	const commitInTransaction = async (
		tx: Transaction<AppDatabase>,
	): Promise<InternalResult> => {
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
		return {
			seq,
			committedDoc: verdict.nextDoc,
			deduped: false,
			persistable,
		};
	};
	const commitOnce = (): Promise<InternalResult> =>
		internalOptions.transaction === undefined
			? withAppTx(commitInTransaction)
			: commitInTransaction(internalOptions.transaction);

	let result: InternalResult;
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

	const { persistable: _persistable, ...publicResult } = result;
	return publicResult;
}

/**
 * Infrastructure-only transaction seam for the migration entrypoint's runtime
 * authority probe. The caller owns commit/rollback; no post-commit side effect
 * may escape that transaction.
 */
export async function commitGuardedBatchInTransaction(
	tx: Transaction<AppDatabase>,
	args: CommitGuardedBatchArgs,
	hooks: CommitGuardedBatchTransactionHooks = {},
): Promise<CommitGuardedBatchResult> {
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

		const previousSnapshot = await loadStrictAppSnapshotFromRowInTransaction(
			tx,
			fresh,
		);
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

async function readProjectMoveThreads(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<ProjectMoveThreadSnapshot[]> {
	const rows = await tx
		.selectFrom("threads")
		.select(["thread_id", "messages"])
		.where("app_id", "=", appId)
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
		.where("app_id", "=", appId)
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
	const destinationIds = freshClosure.map((sourceId) => {
		const destinationId = args.assetIdMap.get(sourceId);
		if (destinationId === undefined) {
			throw new Error(`Missing planned media mapping for ${sourceId}.`);
		}
		return destinationId;
	});

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
	const destinationRequirements = blueprintMediaRequirements(verdict.nextDoc);
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
			deepEqual(
				thread.messages,
				threads.find((source) => source.threadId === thread.threadId)?.messages,
			)
		) {
			continue;
		}
		await tx
			.updateTable("threads")
			.set({ messages: JSON.stringify(thread.messages) })
			.where("app_id", "=", args.appId)
			.where("thread_id", "=", thread.threadId)
			.execute();
	}
	const fullTx = tx as unknown as Transaction<AppDatabase & CaseDatabase>;
	await retenantAppCasesOn(fullTx.$pickTables<keyof CaseDatabase>(), {
		appId: args.appId,
		toProjectId: args.toProjectId,
	});
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
		assetIds: destinationIds,
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
	) {
		super(
			"Another request is already running on this app, only one run can work on an app at a time.",
		);
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
): Promise<ClaimedRun> {
	const period = getCurrentPeriod();
	try {
		const reapable: Array<{
			appId: string;
			identity: ExactRunHolderIdentity;
		}> = [];
		const claimed = await withAppTx(async (tx) => {
			/* The body re-runs from scratch on a deadlock/serialization retry —
			 * reset the collector so a retried scan doesn't double-book reaps. */
			reapable.length = 0;
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
			if (mode === "build") {
				const scan = await scanActiveGeneration(tx, actorUserId, appId);
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
		for (const target of reapable) {
			void reapStaleGenerating(target.appId, target.identity);
		}
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
	const reapable: Array<{
		appId: string;
		identity: ExactRunHolderIdentity;
	}> = [];
	const reservation = await withAppTx(async (tx) => {
		reapable.length = 0;
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
		const scan = await scanActiveGeneration(tx, actorUserId, appId);
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
	for (const target of reapable) {
		void reapStaleGenerating(target.appId, target.identity);
	}
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
 */
export async function completeAndSettleRun(
	appId: string,
	runId: string,
	holderNonce: string,
): Promise<RunHolderWriteOutcome> {
	return await withAppTx(async (tx) => {
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
				const result = await tx
					.updateTable("apps")
					.set({ status: "complete", error_type: null })
					.where("id", "=", appId)
					.where(expectedReapedBuildCompletionPredicate(expectedHolder))
					.executeTakeFirst();
				return updatedExactlyOne(result) ? "owned" : "released";
			}
			return lease.present ? "superseded" : "released";
		}
		const result = await tx
			.updateTable("apps")
			.set({ status: "complete", error_type: null, res_settled: true })
			.where("id", "=", appId)
			.where(expectedRunHolderPredicate(expectedHolder))
			.executeTakeFirst();
		return updatedExactlyOne(result) ? "owned" : "superseded";
	});
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
		await refundStaleGeneration(appId, expectedIdentity);
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
		await refundStaleReservation(appId, expectedIdentity);
	} catch (err) {
		log.error("[reapStaleReservation] reservation refund failed", err, {
			appId,
		});
	}
}

/**
 * Result-bearing canonical reaper used by the Project-move orchestrator. Unlike
 * the scan-side wrappers above, storage failures propagate and a stale identity
 * returns `state_changed`; neither can be mistaken for a successful release.
 */
export async function normalizeReapableRunForProjectMove(
	appId: string,
	expectedIdentity: ExactRunHolderIdentity,
): Promise<StaleRunReapOutcome> {
	return expectedIdentity.mode === "build"
		? refundStaleGeneration(appId, expectedIdentity)
		: refundStaleReservation(appId, expectedIdentity);
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
			return (await loadStrictAppSnapshotFromRowInTransaction(tx, row)).app;
		});
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
