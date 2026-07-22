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
import type { Selectable, Transaction } from "kysely";
import type { ErrorType } from "@/lib/agent";
import { getAuthDb } from "@/lib/auth/db";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import { log } from "@/lib/logger";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import {
	describeMediaExpectationFailures,
	type MediaAttachExpectation,
} from "@/lib/media/attachVerdicts";
import {
	assertPersistenceSafeMutationIdentities,
	describeIntroducedErrors,
	evaluatePreparedMutationCandidate,
	exportReadinessFindings,
	prepareMutationCandidate,
} from "../doc/commitVerdicts";
import { deepEqual } from "../doc/deepEqual";
import { diffDocsToMutations } from "../doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "../doc/fieldParent";
import {
	EMPTY_LOOKUP_REFERENCE_TARGETS,
	extractLookupReferenceTargets,
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupReferenceTargetSet,
	type LookupValidationContext,
	unionLookupReferenceTargetSets,
} from "../doc/lookupReferences";
import { buildReferenceIndex } from "../doc/referenceIndex";
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
	assembleBlueprint,
	decomposeBlueprint,
	diffBlueprints,
	type EntityRow,
} from "./blueprintRows";
import {
	provenRenamePairs,
	type RenameExpectation,
} from "./classifyCaseTypeChanges";
import {
	BlueprintCommitRejectedError,
	batchTargetsMissing,
	CommitReauthError,
	reauthorizeActorForCommit,
} from "./commitGuard";
import {
	debitAndBookReservation,
	type Reservation,
	refundStaleGeneration,
	refundStaleReservation,
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
import { declareLookupReferenceWriter } from "./lookupReferenceWriter";
import { addReferencingApp, getAssetsInTransaction } from "./mediaAssets";
import { getCurrentPeriod } from "./period";
import {
	type AppDatabase,
	type AppsTable,
	getAppDb,
	notifyAppStream,
	withAppTx,
} from "./pg";
import { projectRoleForInTransaction } from "./projectMembership";
import { editLeaseDeadlineMs, runLeaseState } from "./runLiveness";
import type { AcceptedMutationDoc, AppDoc } from "./types";

// ── Types ──────────────────────────────────────────────────────────

/** Subset of AppDoc fields returned by list queries (no blueprint assembly). */
export interface AppSummary {
	id: string;
	app_name: string;
	connect_type: AppDoc["connect_type"];
	module_count: number;
	form_count: number;
	status: AppDoc["status"];
	/** App-logo asset id (a plain column); `null` when unset. */
	logo: string | null;
	/** Error classification string — present only when status is 'error'. */
	error_type: string | null;
	/** ISO 8601 string. */
	created_at: string;
	/** ISO 8601 string. */
	updated_at: string;
}

/**
 * Shape returned by `listDeletedApps` — the standard summary plus the two
 * soft-delete fields, both non-null on any row the query returns. `status`
 * is inherited as-is: soft-delete and lifecycle status are orthogonal axes.
 */
export interface DeletedAppSummary extends AppSummary {
	deleted_at: string;
	recoverable_until: string;
}

/**
 * Narrowed status enum exposed on list/search surfaces. The stored enum also
 * includes `"deleted"` for legacy rows written by the prior status-flip
 * soft-delete flow; soft-deletes are filtered by `deleted_at IS NULL`, so
 * `"deleted"` is never a legitimate filter argument.
 */
export type AppStatus = Exclude<AppDoc["status"], "deleted">;

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

/**
 * Display name for an app whose `appName` has never been set. Rows store the
 * TRUE (possibly empty) name; list projections apply this fallback so every
 * surfaced summary carries a non-empty display name.
 */
export const UNTITLED_APP_NAME = "Untitled";

type AppRow = Selectable<AppsTable>;

// ── Row projections ────────────────────────────────────────────────

/** Assemble the full `AppDoc` from a row + its entity rows. */
function rowToAppDoc(row: AppRow, entities: EntityRow[]): AppDoc {
	const blueprint = assembleBlueprint(
		row.id,
		{
			app_name: row.app_name,
			connect_type: row.connect_type,
			case_types: row.case_types,
			logo: row.logo,
		},
		entities,
	);
	return {
		owner: row.owner,
		project_id: row.project_id,
		app_name: row.app_name,
		blueprint,
		mutation_seq: Number(row.mutation_seq),
		connect_type: row.connect_type,
		module_count: row.module_count,
		form_count: row.form_count,
		status: row.status as AppDoc["status"],
		...(row.awaiting_input && { awaiting_input: true }),
		error_type: row.error_type,
		deleted_at: row.deleted_at?.toISOString() ?? null,
		recoverable_until: row.recoverable_until?.toISOString() ?? null,
		run_id: row.run_id,
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
): Promise<AppRow | undefined> {
	return (await tx
		.selectFrom("apps")
		.selectAll()
		.where("id", "=", appId)
		.forUpdate()
		.executeTakeFirst()) as AppRow | undefined;
}

async function loadEntities(
	tx: Transaction<AppDatabase> | null,
	appId: string,
): Promise<EntityRow[]> {
	const db = tx ?? (await getAppDb());
	const rows = await db
		.selectFrom("blueprint_entities")
		.select(["uuid", "kind", "parent_uuid", "ordinal", "data"])
		.where("app_id", "=", appId)
		.execute();
	return rows as EntityRow[];
}

/** Extract denormalized list-display fields from a persistable doc. The name
 *  columns store the TRUE name; `app_name_lower` carries the display-fallback
 *  lowering so name sorts order exactly what the list shows. */
function denormalize(doc: PersistableDoc) {
	const formCount = doc.moduleOrder.reduce(
		(sum, modUuid) => sum + (doc.formOrder[modUuid]?.length ?? 0),
		0,
	);
	return {
		app_name: doc.appName,
		app_name_lower: (doc.appName || UNTITLED_APP_NAME).toLowerCase(),
		connect_type: doc.connectType ?? null,
		case_types: doc.caseTypes === null ? null : JSON.stringify(doc.caseTypes),
		logo: doc.logo ?? null,
		module_count: doc.moduleOrder.length,
		form_count: formCount,
	};
}

/**
 * Maintain the media reverse index for a saved blueprint: record `appId`
 * against every asset the doc references, so the delete reference guard reads
 * a candidate set instead of loading every app. Post-commit + best-effort — a
 * failure logs, never throws (the media validator at export is the
 * correctness backstop, and the next save re-adds a dropped edge). Built-in
 * icon refs (`nova-icon:<slug>`) have no asset row and need no index.
 */
async function syncMediaReferences(
	appId: string,
	doc: PersistableDoc,
): Promise<void> {
	try {
		await addReferencingApp(collectRealAssetRefs(asWalkableDoc(doc)), appId);
	} catch (err) {
		log.error("[syncMediaReferences] reverse-index update failed", err, {
			appId,
		});
	}
}

function hasLookupReferenceTargets(targets: LookupReferenceTargetSet): boolean {
	return targets.tableIds.length > 0 || targets.columnTargets.length > 0;
}

/**
 * Freeze the exact tables one candidate pair can reference, then read the
 * rows-free definitions against that same transaction snapshot. Non-Project
 * legacy apps receive the explicit unavailable context and may only save a
 * candidate whose structural target set is empty.
 */
async function lookupContextForAuthoritativeWrite(
	tx: Transaction<AppDatabase>,
	projectId: string | null,
	targets: LookupReferenceTargetSet,
): Promise<LookupValidationContext> {
	if (projectId === null) return LOOKUP_CONTEXT_UNAVAILABLE;
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

/** Map a replay-unsafe payload to the commit rejection shape wire callers know. */
function assertDeterministicPersistedMutations(
	mutations: readonly Mutation[],
): void {
	try {
		assertPersistenceSafeMutationIdentities(mutations);
	} catch (error) {
		throw new BlueprintCommitRejectedError(
			error instanceof Error
				? error.message
				: "This mutation batch cannot be persisted deterministically.",
		);
	}
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
	for (const appId of reapable) void reapStaleGenerating(appId);
	return live;
}

/** The scan body, callable inside a transaction (side-effect free — the
 *  caller fires the collected reaps after commit). */
async function scanActiveGeneration(
	db: Pick<Transaction<AppDatabase>, "selectFrom">,
	actorUserId: string,
	excludeAppId?: string,
): Promise<{ live: boolean; reapable: string[] }> {
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
	const reapable: string[] = [];
	let live = false;
	for (const row of rows) {
		/* A co-member's run on THIS user's owned app is the co-member's
		 * concurrency, not this user's. A marker-less owner match (the new-build
		 * window) has no run actor yet and is kept. */
		const runActor = row.res_user_id ?? undefined;
		if (runActor !== undefined && runActor !== actorUserId) continue;
		const lease = runLeaseState(leaseView(row as AppRow), now);
		if (lease.live) live = true;
		else if (lease.reapableStaleBuild) reapable.push(row.id);
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

/** Optional overrides for `createApp`. */
export interface CreateAppOptions {
	/** Initial app name. Empty string when unset — display falls back to
	 *  `UNTITLED_APP_NAME` at projection time. */
	appName?: string;
	/**
	 * Initial lifecycle status. `"generating"` arms the staleness clock (the
	 * chat build's run-liveness marker); `"complete"` is the at-rest default
	 * for every other creation. `"error"`/`"deleted"` are excluded — a fresh
	 * app has failed at nothing and soft-delete is out-of-band.
	 */
	status?: "generating" | "complete";
	/**
	 * The contents the app is BORN with — a template expressed as a mutation
	 * batch against the empty doc. The callback and reducer each run exactly once
	 * before the retryable transaction; the prepared candidate is then admitted
	 * and inserted atomically, so no pre-template app is ever visible.
	 * Supplying one is a promise the app is born EXPORT-ready, enforced by
	 * `createApp`. Omit for the empty app the chat build and MCP mint.
	 */
	seedMutations?: (doc: BlueprintDoc) => Mutation[];
}

/**
 * Create a new app: one transaction inserting the `apps` row plus the entity
 * rows of whatever the template seeded. Returns the new app id.
 */
export async function createApp(
	owner: string,
	projectId: string,
	runId: string,
	opts?: CreateAppOptions,
): Promise<string> {
	const appId = crypto.randomUUID();
	const emptyDoc: BlueprintDoc = {
		appId,
		appName: opts?.appName ?? "",
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
	// transaction closure, so the template callback and reducer must stay out of
	// it. The prepared value is deterministic and safe to evaluate repeatedly.
	const seedMutations = opts?.seedMutations?.(emptyDoc) ?? [];
	assertDeterministicPersistedMutations(seedMutations);
	const prepared = prepareMutationCandidate(emptyDoc, seedMutations);
	const candidateTargets = extractLookupReferenceTargets(prepared.nextDoc);
	const persistable = toPersistableDoc(prepared.nextDoc);
	const denorm = denormalize(persistable);
	await withAppTx(async (tx) => {
		await declareLookupReferenceWriter(tx);
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
				mutation_seq: 0,
				status: opts?.status ?? "generating",
				awaiting_input: false,
				error_type: null,
				deleted_at: null,
				recoverable_until: null,
				run_id: runId,
			})
			.execute();
		const lookupContext = await lookupContextForAuthoritativeWrite(
			tx,
			projectId,
			candidateTargets,
		);
		const verdict = evaluatePreparedMutationCandidate(
			emptyDoc,
			prepared,
			lookupContext,
		);
		if (!verdict.ok) {
			throw new Error(
				`App template is not valid by construction: ${describeIntroducedErrors(
					verdict.introduced,
				)}`,
			);
		}
		if (opts?.seedMutations !== undefined) {
			const notExportable = exportReadinessFindings(
				verdict.nextDoc,
				lookupContext,
			);
			if (notExportable.length > 0) {
				throw new Error(
					`App template must be born export-ready, but the app it creates could not be exported:\n${notExportable
						.map((error) => `- ${error.message}`)
						.join("\n")}`,
				);
			}
		}
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
	});
	return appId;
}

// ── Committed-batch writer ──────────────────────────────────────────

/**
 * The one committed-batch write — the shared tail of every guarded commit.
 * On the caller's transaction (which holds the app row lock): write the
 * entity-row DIFF (only what changed), stamp the scalars + denormalized
 * summary + `mutation_seq` at the caller's LITERAL `seq`, append the
 * PERMANENT `accepted_mutations` entry (whose `UNIQUE (app_id, batch_id)` is
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
		mutations: Mutation[];
		actorUserId: string;
		kind: AcceptedMutationDoc["kind"];
		extraAppFields?: Partial<{
			project_id: string;
			lock_expire_at: Date;
		}>;
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
	await tx
		.updateTable("apps")
		.set({
			...denormalize(args.committedDoc),
			mutation_seq: args.seq,
			updated_at: new Date(),
			...(args.runId !== undefined && { run_id: args.runId }),
			...args.extraAppFields,
		})
		.where("id", "=", args.appId)
		.execute();
	await tx
		.insertInto("accepted_mutations")
		.values({
			app_id: args.appId,
			seq: args.seq,
			batch_id: args.batchId,
			run_id: args.runId ?? null,
			actor_id: args.actorUserId,
			kind: args.kind,
			mutations: JSON.stringify(args.mutations),
		})
		.execute();
	await notifyAppStream(tx, args.appId, args.seq);
}

/** Arguments for {@link commitGuardedBatch}. */
export interface CommitGuardedBatchArgs {
	readonly appId: string;
	/** Client-minted idempotency key; a re-commit of the same id is a no-op. */
	readonly batchId: string;
	/** The SA run that produced the batch (chat/mcp); absent for an autosave. */
	readonly runId?: string;
	readonly mutations: Mutation[];
	/** The acting user — reauth + attribution key, never the tenant. */
	readonly actorUserId: string;
	readonly kind: AcceptedMutationDoc["kind"];
	readonly mediaExpectations?: readonly MediaAttachExpectation[];
	/**
	 * The rename pairs the caller's Phase-1 case-store migration covered
	 * (the cross-store saga passes this, possibly EMPTY). When present,
	 * the commit re-proves renames against the FRESH doc pair inside the
	 * transaction (`provenRenamePairs`) and REJECTS if the re-apply
	 * would rename a pair not in this list — the batch was prepared
	 * against a prior that trailed a concurrent commit, and letting it
	 * land would strand row values with the rename evidence expired
	 * (both sides of every later diff would already hold the new name).
	 * Absent (direct chat fast-path / cross-Project-move callers, whose
	 * batches carry no rename kinds): no check.
	 */
	readonly renameExpectations?: readonly RenameExpectation[];
	/**
	 * A `{ projectId }` the caller ALREADY resolved and reauthed the actor's
	 * role against moments ago (the migration-bearing `applyBlueprintChange`
	 * path, which reauths before its Phase-1 DDL). When present, the
	 * pre-transaction reauth here is skipped; the IN-transaction checks remain
	 * the authoritative gate either way.
	 */
	readonly preauthorized?: { readonly projectId: string | null };
}

/** Outcome of {@link commitGuardedBatch}. */
export interface CommitGuardedBatchResult {
	readonly seq: number;
	/** The committed doc, fully hydrated (`fieldParent` + `refIndex`). */
	readonly committedDoc: BlueprintDoc;
	/** True when the `batchId` was already committed (nothing written). */
	readonly deduped: boolean;
}

/** Postgres unique-violation SQLSTATE — the dedup latch's concurrent-retry arm. */
function isUniqueViolation(err: unknown): boolean {
	return (err as { code?: unknown })?.code === "23505";
}

/**
 * The unified guarded blueprint commit — the read-evaluate-write every
 * interactive mutation path (chat, MCP, auto-save) shares. Synthetic repairs
 * and the dormant cross-Project move use the parallel locked protocols below.
 *
 * One transaction: lock the app row (the per-app serialization point); a
 * dedup hit on `(app_id, batch_id)` returns the recorded seq + the current
 * committed doc, writing nothing; lock + reauthorize the actor's exact Project
 * membership against the fresh row (owner fallback for a null Project; a
 * concurrent MOVE rejects retryably);
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
): Promise<CommitGuardedBatchResult> {
	const { appId, batchId, runId, mutations, actorUserId, kind } = args;
	const mediaExpectations = args.mediaExpectations;

	// Pre-transaction reauth for the common (non-null project) case — out of
	// the lock. A null `project_id` defers to the in-transaction owner check.
	let projectId: string | null;
	if (args.preauthorized !== undefined) {
		projectId = args.preauthorized.projectId;
	} else {
		projectId = await loadAppProjectId(appId);
		await reauthorizeActorForCommit(projectId, actorUserId);
	}

	type InternalResult = CommitGuardedBatchResult & {
		persistable?: PersistedBlueprint;
	};

	const commitOnce = (): Promise<InternalResult> =>
		withAppTx(async (tx) => {
			await declareLookupReferenceWriter(tx);
			const fresh = await lockAppRow(tx, appId);
			if (!fresh) {
				throw new Error(
					`[commitGuardedBatch] app row missing for appId=${appId}`,
				);
			}
			// Idempotent replay of an already-committed batch — the latch read
			// happens under the app row lock, so it observes every prior commit.
			const latch = await tx
				.selectFrom("accepted_mutations")
				.select("seq")
				.where("app_id", "=", appId)
				.where("batch_id", "=", batchId)
				.executeTakeFirst();
			// The outside role read is only an early rejection optimization. The app
			// row and the actor's exact membership row now join this transaction's
			// lock set before either a real commit OR an idempotent return.
			if (fresh.project_id !== projectId) {
				throw new BlueprintCommitRejectedError(
					"This app moved to a different Project while you were editing. Reload to get the latest state.",
				);
			}
			if (fresh.project_id === null) {
				if (fresh.owner !== actorUserId) {
					throw new CommitReauthError(
						"You don't have edit access to this app.",
					);
				}
			} else {
				await assertProjectCapabilityInTransaction(
					tx,
					actorUserId,
					fresh.project_id,
					"edit",
					"You no longer have edit access to this app's Project.",
				);
			}
			const entities = await loadEntities(tx, appId);
			const freshPersistable = assembleBlueprint(
				appId,
				{
					app_name: fresh.app_name,
					connect_type: fresh.connect_type,
					case_types: fresh.case_types,
					logo: fresh.logo,
				},
				entities,
			);
			if (latch) {
				const dedupedDoc = hydratePersistedBlueprint(freshPersistable);
				dedupedDoc.refIndex = buildReferenceIndex(dedupedDoc);
				return {
					seq: Number(latch.seq),
					committedDoc: dedupedDoc,
					deduped: true,
				};
			}
			// Media-attach expectations re-check — the asset rows are read FOR
			// SHARE so a racing delete serializes against this commit.
			if (mediaExpectations !== undefined && mediaExpectations.length > 0) {
				if (!fresh.project_id) {
					throw new BlueprintCommitRejectedError(
						"This app has no Project, so its media can't be verified. Reload and try again.",
					);
				}
				const rows = await getAssetsInTransaction(
					tx,
					mediaExpectations.map((e) => e.assetId),
				);
				const failure = describeMediaExpectationFailures(
					mediaExpectations,
					rows,
					fresh.project_id,
				);
				if (failure !== null) throw new BlueprintCommitRejectedError(failure);
			}
			// Rebuild the fresh doc, reject a concurrent-delete target, re-verdict.
			const freshDoc = hydratePersistedBlueprint(freshPersistable);
			assertDeterministicPersistedMutations(mutations);
			if (batchTargetsMissing(freshDoc, mutations)) {
				throw new BlueprintCommitRejectedError(
					"This app changed while you were editing — something your change " +
						"targeted was removed by someone else. Reload to get the latest " +
						"version, then redo that change.",
				);
			}
			const prepared = prepareMutationCandidate(freshDoc, mutations);
			const previousTargets = extractLookupReferenceTargets(freshDoc);
			const candidateTargets = extractLookupReferenceTargets(prepared.nextDoc);
			if (
				fresh.project_id === null &&
				hasLookupReferenceTargets(candidateTargets)
			) {
				throw new BlueprintCommitRejectedError(
					"This legacy app has no Project, so it cannot save lookup references. Move or repair the app, then try again.",
				);
			}
			const lookupTargets = unionLookupReferenceTargetSets(
				previousTargets,
				candidateTargets,
			);
			const lookupContext = await lookupContextForAuthoritativeWrite(
				tx,
				fresh.project_id,
				lookupTargets,
			);
			const verdict = evaluatePreparedMutationCandidate(
				freshDoc,
				prepared,
				lookupContext,
			);
			if (!verdict.ok) {
				throw new BlueprintCommitRejectedError(
					describeIntroducedErrors(verdict.introduced),
				);
			}
			// Rename-expectation gate — re-prove renames against the FRESH
			// pair. A fresh-proven pair the caller's Phase-1 migration did
			// not cover means the batch renames something other than what
			// was migrated (its prior trailed a concurrent commit);
			// committing it would strand row values permanently, because
			// after this commit both sides of every future diff hold the
			// new name and no sync can ever prove the migration again. The
			// reverse asymmetry is fine: an expected pair the fresh diff
			// does NOT prove means a peer already committed the same
			// rename (the forward migration no-oped) — nothing to reject.
			if (args.renameExpectations !== undefined) {
				const proven = provenRenamePairs(freshDoc, verdict.nextDoc);
				for (const [renamedType, pairs] of proven) {
					for (const pair of pairs) {
						const covered = args.renameExpectations.some(
							(expectation) =>
								expectation.caseType === renamedType &&
								expectation.from === pair.from &&
								expectation.to === pair.to,
						);
						if (!covered) {
							throw new BlueprintCommitRejectedError(
								`This change would rename the case property "${pair.from}" to "${pair.to}" on "${renamedType}", but it was prepared against an older version of the app and the saved case data was migrated for a different rename. Reload to get the latest state, then redo the rename.`,
							);
						}
					}
				}
			}
			const seq = Number(fresh.mutation_seq) + 1;
			const persistable = toPersistableDoc(verdict.nextDoc);
			/* Per-commit EDIT lease refresh — the run-lock analogue of the build's
			 * per-commit `updated_at` stamp. Fires only when THIS commit's run OWNS
			 * the edit lock (through the one liveness reader). */
			const commitLease =
				runId !== undefined ? runLeaseState(leaseView(fresh)) : undefined;
			const ownsEditLock =
				runId !== undefined &&
				commitLease?.mode === "edit" &&
				commitLease?.mine(runId);
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
		});

	let result: InternalResult;
	try {
		result = await commitOnce();
	} catch (err) {
		// A concurrent commit of the SAME batchId slipped between our latch read
		// and insert — the UNIQUE constraint caught it; converge on the dedup.
		if (!isUniqueViolation(err)) throw err;
		result = await commitOnce();
	}

	// Post-commit media reverse-index sync — best-effort, only on a real commit.
	if (!result.deduped && result.persistable !== undefined) {
		await syncMediaReferences(appId, result.persistable);
	}
	const { persistable: _persistable, ...publicResult } = result;
	return publicResult;
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
	// `actorId` is the durable attribution in `accepted_mutations`; `reason` is
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
	// Hydration/backfill is deterministic and independent of the locked basis.
	// Keep it outside the retryable transaction closure.
	const requestedTarget = hydratePersistedBlueprint(args.targetDoc);

	type InternalResult = AppendSyntheticBatchResult & {
		persistable?: PersistedBlueprint;
	};
	const result = await withAppTx(async (tx): Promise<InternalResult> => {
		await declareLookupReferenceWriter(tx);
		const fresh = await lockAppRow(tx, args.appId);
		if (!fresh) {
			throw new Error("[appendSyntheticBatch] app row is unavailable");
		}
		const latch = await tx
			.selectFrom("accepted_mutations")
			.select("seq")
			.where("app_id", "=", args.appId)
			.where("batch_id", "=", batchId)
			.executeTakeFirst();
		if (args.authority.kind === "user") {
			if (fresh.project_id === null) {
				if (fresh.owner !== args.authority.actorUserId) {
					throw new CommitReauthError(
						"You don't have edit access to this app.",
					);
				}
			} else {
				await assertProjectCapabilityInTransaction(
					tx,
					args.authority.actorUserId,
					fresh.project_id,
					"edit",
					"You no longer have edit access to this app's Project.",
				);
			}
		}
		if (latch) return { kind: "deduped", seq: Number(latch.seq) };
		if (Number(fresh.mutation_seq) !== args.expectedBaseSeq) {
			throw new BlueprintCommitRejectedError(
				"This app changed while the repair was being prepared. Reload the latest app and prepare the repair again.",
			);
		}

		const entities = await loadEntities(tx, args.appId);
		const previousPersistable = assembleBlueprint(
			args.appId,
			{
				app_name: fresh.app_name,
				connect_type: fresh.connect_type,
				case_types: fresh.case_types,
				logo: fresh.logo,
			},
			entities,
		);
		const previousDoc = hydratePersistedBlueprint(previousPersistable);
		const mutations = diffDocsToMutations(previousDoc, requestedTarget);
		assertDeterministicPersistedMutations(mutations);
		const prepared = prepareMutationCandidate(previousDoc, mutations);
		const replayed = toPersistableDoc(prepared.nextDoc);
		const requested = toPersistableDoc(requestedTarget);
		if (!deepEqual(replayed, requested)) {
			throw new BlueprintCommitRejectedError(
				"The requested repair cannot be represented as a deterministic mutation batch.",
			);
		}
		if (mutations.length === 0) {
			return { kind: "noop", seq: Number(fresh.mutation_seq) };
		}
		if (batchTargetsMissing(previousDoc, mutations)) {
			throw new BlueprintCommitRejectedError(
				"This app changed while the repair was being prepared. Reload the latest app and prepare the repair again.",
			);
		}
		const previousTargets = extractLookupReferenceTargets(previousDoc);
		const candidateTargets = extractLookupReferenceTargets(prepared.nextDoc);
		if (
			fresh.project_id === null &&
			hasLookupReferenceTargets(candidateTargets)
		) {
			throw new BlueprintCommitRejectedError(
				"This legacy app has no Project, so it cannot save lookup references.",
			);
		}
		const lookupTargets = unionLookupReferenceTargetSets(
			previousTargets,
			candidateTargets,
		);
		const lookupContext = await lookupContextForAuthoritativeWrite(
			tx,
			fresh.project_id,
			lookupTargets,
		);
		const verdict = evaluatePreparedMutationCandidate(
			previousDoc,
			prepared,
			lookupContext,
		);
		if (!verdict.ok) {
			throw new BlueprintCommitRejectedError(
				describeIntroducedErrors(verdict.introduced),
			);
		}
		const persistable = toPersistableDoc(verdict.nextDoc);
		const seq = Number(fresh.mutation_seq) + 1;
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
			kind: "migration",
		});
		return { kind: "committed", seq, persistable };
	});
	if (result.kind === "committed" && result.persistable !== undefined) {
		await syncMediaReferences(args.appId, result.persistable);
	}
	const { persistable: _persistable, ...publicResult } = result;
	return publicResult;
}

/**
 * Outcome of {@link commitAppProjectMove}. `moved` and `already_moved` are
 * terminal success; `media_stale` reports asset ids the FRESH doc references
 * that the caller never copied (a concurrent edit added them), so the move
 * orchestrator copies those and retries.
 */
export type CommitMoveResult =
	| { kind: "moved" }
	| { kind: "already_moved" }
	| { kind: "media_stale"; missing: string[] }
	| { kind: "busy" };

/**
 * The single write that changes an app's `project_id` — the commit point of a
 * cross-Project move. In one transaction over the locked row it repoints the
 * blueprint's media refs onto the destination copies and flips `project_id`,
 * so a co-editor's stale tab 409-reloads (its next PUT's in-transaction
 * `project_id` compare rejects) and the blueprint never spends an instant
 * referencing destination-absent media. Writes nothing on any non-`moved`
 * outcome.
 */
export async function commitAppProjectMove(
	appId: string,
	args: {
		toProjectId: string;
		expectedFromProjectId: string;
		actorUserId: string;
		assetIdMap: ReadonlyMap<string, string>;
		attemptedRealIds: ReadonlySet<string>;
	},
): Promise<CommitMoveResult> {
	const batchId = crypto.randomUUID();
	const result = await withAppTx(
		async (
			tx,
		): Promise<{
			outcome: CommitMoveResult;
			committed: PersistedBlueprint | null;
		}> => {
			await declareLookupReferenceWriter(tx);
			const fresh = await lockAppRow(tx, appId);
			if (!fresh) {
				throw new Error(
					`[commitAppProjectMove] app row missing for appId=${appId}`,
				);
			}
			if (fresh.project_id === args.toProjectId) {
				await assertProjectCapabilityInTransaction(
					tx,
					args.actorUserId,
					args.toProjectId,
					"delete",
					"You no longer have permission to move this app.",
				);
				return { outcome: { kind: "already_moved" }, committed: null };
			}
			if (fresh.project_id !== args.expectedFromProjectId) {
				throw new BlueprintCommitRejectedError(
					"This app changed Projects while the move was being prepared. Reload and try again.",
				);
			}
			// S02b deliberately locks only the actor's existing membership tuples.
			// The sorted order avoids opposite-direction lock inversion; S02c adds
			// the membership advisory gate and owner-retention/absence protocol.
			for (const projectId of [
				...new Set([args.expectedFromProjectId, args.toProjectId]),
			].sort()) {
				await assertProjectCapabilityInTransaction(
					tx,
					args.actorUserId,
					projectId,
					"delete",
					"You no longer have permission to move this app.",
				);
			}
			// A build that started after the caller's authz read would, on its
			// next save, blind-overwrite the repoint while leaving project_id
			// flipped. Re-check against the LOCKED row so the bar is atomic.
			if (fresh.status === "generating") {
				return { outcome: { kind: "busy" }, committed: null };
			}
			const entities = await loadEntities(tx, appId);
			const prevDoc = assembleBlueprint(
				appId,
				{
					app_name: fresh.app_name,
					connect_type: fresh.connect_type,
					case_types: fresh.case_types,
					logo: fresh.logo,
				},
				entities,
			);
			const previousDoc = hydratePersistedBlueprint(prevDoc);
			const missing = collectRealAssetRefs(asWalkableDoc(previousDoc)).filter(
				(id) => !args.attemptedRealIds.has(id),
			);
			if (missing.length > 0) {
				return { outcome: { kind: "media_stale", missing }, committed: null };
			}
			const requestedCandidate =
				args.assetIdMap.size > 0
					? hydratePersistedBlueprint(
							toPersistableDoc(remapAssetRefs(previousDoc, args.assetIdMap)),
						)
					: previousDoc;
			const mutations = diffDocsToMutations(previousDoc, requestedCandidate);
			assertDeterministicPersistedMutations(mutations);
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
			const previousTargets = extractLookupReferenceTargets(previousDoc);
			const candidateTargets = extractLookupReferenceTargets(prepared.nextDoc);
			const storedTargets = await readStoredLookupReferenceTargets(tx, appId);
			if (
				hasLookupReferenceTargets(previousTargets) ||
				hasLookupReferenceTargets(candidateTargets) ||
				hasLookupReferenceTargets(storedTargets)
			) {
				throw new BlueprintCommitRejectedError(
					"This app uses lookup tables and cannot move Projects yet. Remove those references or keep the app in its current Project.",
				);
			}
			const destinationContext = await lookupContextForAuthoritativeWrite(
				tx,
				args.toProjectId,
				EMPTY_LOOKUP_REFERENCE_TARGETS,
			);
			const verdict = evaluatePreparedMutationCandidate(
				previousDoc,
				prepared,
				destinationContext,
			);
			if (!verdict.ok) {
				throw new BlueprintCommitRejectedError(
					describeIntroducedErrors(verdict.introduced),
				);
			}
			const seq = Number(fresh.mutation_seq) + 1;
			const committedDoc = toPersistableDoc(verdict.nextDoc);
			await replaceLookupReferenceEdges(tx, {
				appId,
				projectId: fresh.project_id,
				targets: EMPTY_LOOKUP_REFERENCE_TARGETS,
			});
			await writeCommittedBatch(tx, {
				appId,
				seq,
				batchId,
				prevDoc,
				committedDoc,
				mutations,
				actorUserId: args.actorUserId,
				kind: "migration",
				extraAppFields: { project_id: args.toProjectId },
			});
			return {
				outcome: { kind: "moved" },
				committed: mutations.length > 0 ? committedDoc : null,
			};
		},
	);
	if (result.committed) {
		await syncMediaReferences(appId, result.committed);
	}
	return result.outcome;
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
	) {
		super(
			"Another request is already running on this app — only one run can work on an app at a time.",
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
 *  4. The claim writes: build → `status: generating` + fresh `updated_at`,
 *     clear `error_type`/`awaiting_input`/any stale lock; edit → fresh
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
): Promise<ClaimedRun> {
	const period = getCurrentPeriod();
	try {
		const reapable: string[] = [];
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
						updated_at: new Date(),
						lock_run_id: null,
						lock_actor_user_id: null,
						lock_expire_at: null,
					})
					.where("id", "=", appId)
					.execute();
			}
			return { mode, reservation: { period, reserved: cost } };
		});
		for (const id of reapable) void reapStaleGenerating(id);
		return claimed;
	} catch (err) {
		/* A conflict with a REAPABLE holder — an abandoned run whose lease
		 * lapsed. Run the matching reaper on the waiter's own path (awaited, so
		 * the next poll deterministically finds the freed app); each reaper
		 * re-validates its staleness in-txn and swallows its own faults. */
		if (err instanceof RunConflictError) {
			if (err.reapableStaleBuild) await reapStaleGenerating(appId);
			else if (err.reapableStrandedEdit) await reapStaleReservation(appId);
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
): Promise<Reservation> {
	const period = getCurrentPeriod();
	const reapable: string[] = [];
	const reservation = await withAppTx(async (tx) => {
		reapable.length = 0;
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) {
			throw new Error(
				`[reserveForNewBuild] app row missing for appId=${appId}`,
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
			period,
			priorMarker: rowReservation(fresh),
			owner: fresh.owner,
		});
		return { period, reserved: cost };
	});
	for (const id of reapable) void reapStaleGenerating(id);
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
 * `run_id === runId` (the last committed batch is THIS run's) flips the row
 * back to `complete` without touching the marker; the reaper's refund stands.
 */
export async function completeAndSettleRun(
	appId: string,
	runId: string,
): Promise<void> {
	await withAppTx(async (tx) => {
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) return;
		const lease = runLeaseState(leaseView(fresh));
		if (lease.mode !== "build" || !lease.terminalWriteOwned(runId)) {
			if (
				fresh.status === "error" &&
				lease.mode === "none" &&
				lease.reaperResolved &&
				fresh.run_id === runId
			) {
				await tx
					.updateTable("apps")
					.set({ status: "complete", error_type: null })
					.where("id", "=", appId)
					.execute();
			}
			return;
		}
		await tx
			.updateTable("apps")
			.set({ status: "complete", error_type: null, res_settled: true })
			.where("id", "=", appId)
			.execute();
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
): Promise<void> {
	await withAppTx(async (tx) => {
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) return;
		const lease = runLeaseState(leaseView(fresh));
		if (!(lease.mode === "edit" && lease.mine(runId))) return;
		await tx
			.updateTable("apps")
			.set({ lock_expire_at: new Date(editLeaseDeadlineMs()) })
			.where("id", "=", appId)
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
): Promise<void> {
	await withAppTx(async (tx) => {
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) return;
		const lease = runLeaseState(leaseView(fresh));
		if (!(lease.mode === "build" && lease.mine(runId))) return;
		await tx
			.updateTable("apps")
			.set({ updated_at: new Date() })
			.where("id", "=", appId)
			.execute();
	});
}

/**
 * Release an edit run's `run_lock` WITHOUT touching the reservation marker —
 * for terminal states that are NOT a clean kept-charge completion (a failed
 * edit whose marker the failure funnel already settled, the prelude-throw
 * net's release of a stranded lock). Fire-and-forget; a dropped clear
 * degrades to the lock expiring at `expireAt`.
 */
export function clearRunLock(appId: string): Promise<void> {
	return getAppDb()
		.then((db) =>
			db
				.updateTable("apps")
				.set({
					lock_run_id: null,
					lock_actor_user_id: null,
					lock_expire_at: null,
				})
				.where("id", "=", appId)
				.execute(),
		)
		.then(
			() => {},
			(err) => {
				log.error("[clearRunLock] write failed", err, { appId });
			},
		);
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
): Promise<void> {
	await withAppTx(async (tx) => {
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) return;
		const lease = runLeaseState(leaseView(fresh));
		if (lease.mode !== "edit" || !lease.terminalWriteOwned(runId)) return;
		const reservation = rowReservation(fresh);
		await tx
			.updateTable("apps")
			.set({
				lock_run_id: null,
				lock_actor_user_id: null,
				lock_expire_at: null,
				...(reservation && !reservation.settled && { res_settled: true }),
			})
			.where("id", "=", appId)
			.execute();
	});
}

/**
 * Whether the app is STILL an EDIT run owned by `runId` — the guard the
 * route's prelude-throw net runs before releasing a stranded lock.
 */
export async function editRunLockHeldBy(
	appId: string,
	runId: string,
): Promise<boolean> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("apps")
		.select(LEASE_COLUMNS)
		.where("id", "=", appId)
		.executeTakeFirst();
	if (!row) return false;
	const lease = runLeaseState(leaseView(row as AppRow));
	return lease.mode === "edit" && lease.mine(runId);
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
 * still OWN the run (`ownedByResume`, keyed on the resume's own mode) and
 * RENEW its horizon (edit → re-stamp the lease; build → re-arm `updated_at`)
 * + clear `awaiting_input` atomically. A lost resume touched nothing; the
 * return distinguishes WHY so the route's message can be true:
 * `"superseded"` (another run occupies the freed app) vs `"released"` (the
 * reap simply freed it — on a personal Project the only lost shape).
 */
export type ReacquireOutcome = "owned" | "superseded" | "released";

export async function reacquireLease(
	appId: string,
	runId: string,
	mode: "build" | "edit",
): Promise<ReacquireOutcome> {
	return await withAppTx(async (tx) => {
		const fresh = await lockAppRow(tx, appId);
		if (!fresh) return "released";
		const lease = runLeaseState(leaseView(fresh));
		if (!lease.ownedByResume(runId, mode)) {
			return lease.present ? "superseded" : "released";
		}
		if (mode === "edit") {
			await tx
				.updateTable("apps")
				.set({
					lock_expire_at: new Date(editLeaseDeadlineMs()),
					awaiting_input: false,
				})
				.where("id", "=", appId)
				.execute();
		} else {
			await tx
				.updateTable("apps")
				.set({ updated_at: new Date(), awaiting_input: false })
				.where("id", "=", appId)
				.execute();
		}
		return "owned";
	});
}

/**
 * Mark an app as failed after an error during generation. Fire-and-forget —
 * a storage outage must never block the error response; the staleness reaper
 * is the backstop.
 */
export function failApp(appId: string, errorType: ErrorType): Promise<void> {
	return getAppDb()
		.then((db) =>
			db
				.updateTable("apps")
				.set({ status: "error", error_type: errorType })
				.where("id", "=", appId)
				.execute(),
		)
		.then(
			() => {},
			(err) => log.error("[failApp] write failed", err),
		);
}

/**
 * Set or clear a build's `awaiting_input` pause flag. Clearing ALSO re-arms
 * `updated_at` — the flag (not a fresh timestamp) is what spared the row from
 * staleness during the pause, so removing it must hand the resuming run a
 * fresh window; the SET path must NOT bump the clock. The route AWAITS the
 * pause SET (durably recorded before the response resolves); the resume CLEAR
 * is fire-and-forget.
 */
export function setAwaitingInput(
	appId: string,
	awaiting: boolean,
): Promise<void> {
	return getAppDb()
		.then((db) =>
			db
				.updateTable("apps")
				.set(
					awaiting
						? { awaiting_input: true }
						: { awaiting_input: false, updated_at: new Date() },
				)
				.where("id", "=", appId)
				.execute(),
		)
		.then(
			() => {},
			(err) => {
				log.error("[setAwaitingInput] write failed", err);
			},
		);
}

/**
 * Reap a stale `generating` app: refund its stranded credit reservation +
 * flip it to `error` in one transaction with the staleness RE-VALIDATED
 * inside it (`refundStaleGeneration`) — so a fresh build that re-claimed
 * between the scan and the reap reads live and the reap no-ops. Idempotent;
 * fire-and-forget at the scan call sites and AWAITED from the claim's
 * conflict nudge.
 */
export async function reapStaleGenerating(appId: string): Promise<void> {
	try {
		await refundStaleGeneration(appId);
	} catch (err) {
		log.error("[reapStaleGenerating] stale-build reap failed", err, { appId });
	}
}

/**
 * Reap a stranded EDIT reservation: refund an unsettled hold whose run never
 * reached a clean completion, releasing the lapsed `run_lock` in the same
 * commit, WITHOUT flipping status. The pre-filter here only avoids opening a
 * transaction on the common not-reapable row; `refundStaleReservation`
 * re-validates the whole guard inside its transaction.
 */
export async function reapStaleReservation(appId: string): Promise<void> {
	try {
		const db = await getAppDb();
		const row = await db
			.selectFrom("apps")
			.select(LEASE_COLUMNS)
			.where("id", "=", appId)
			.executeTakeFirst();
		if (!row || !runLeaseState(leaseView(row)).reapableStrandedEdit) return;
		await refundStaleReservation(appId);
	} catch (err) {
		log.error("[reapStaleReservation] reservation refund failed", err, {
			appId,
		});
	}
}

// ── Soft delete / restore ───────────────────────────────────────────

/**
 * Soft-delete an app: record `deleted_at` + the recovery deadline. Status is
 * intentionally untouched — lifecycle status and existence are independent
 * axes. Throws on a missing row (matching the update-a-ghost posture).
 * Returns the ISO `recoverable_until` so callers surface the deadline.
 */
export async function softDeleteApp(appId: string): Promise<string> {
	const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
	const now = new Date();
	const recoverableUntil = new Date(now.getTime() + RETENTION_MS);
	const db = await getAppDb();
	const result = await db
		.updateTable("apps")
		.set({ deleted_at: now, recoverable_until: recoverableUntil })
		.where("id", "=", appId)
		.executeTakeFirst();
	if (Number(result.numUpdatedRows) === 0) {
		throw new Error(`[softDeleteApp] app row missing for appId=${appId}`);
	}
	return recoverableUntil.toISOString();
}

/** Restore a soft-deleted app — clears both soft-delete fields as a pair;
 *  status untouched; `updated_at` deliberately not bumped. */
export async function restoreApp(appId: string): Promise<void> {
	const db = await getAppDb();
	const result = await db
		.updateTable("apps")
		.set({ deleted_at: null, recoverable_until: null })
		.where("id", "=", appId)
		.executeTakeFirst();
	if (Number(result.numUpdatedRows) === 0) {
		throw new Error(`[restoreApp] app row missing for appId=${appId}`);
	}
}

// ── Loads ───────────────────────────────────────────────────────────

/**
 * Load a single app by ID — the row plus its assembled blueprint. Returns
 * null if not found. Callers that serve user-facing data must authorize via
 * `resolveAppAccess` — the table doesn't scope by user.
 */
export async function loadApp(appId: string): Promise<AppDoc | null> {
	const db = await getAppDb();
	const row = (await db
		.selectFrom("apps")
		.selectAll()
		.where("id", "=", appId)
		.executeTakeFirst()) as AppRow | undefined;
	if (!row) return null;
	const entities = await loadEntities(null, appId);
	return rowToAppDoc(row, entities);
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

/** Load just the owning Project id — the lightweight authorization read. */
export async function loadAppProjectId(appId: string): Promise<string | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("apps")
		.select("project_id")
		.where("id", "=", appId)
		.executeTakeFirst();
	return row?.project_id ?? null;
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
function projectAppSummary(row: AppRow, now: number): AppSummary {
	const lease = runLeaseState(leaseView(row), now);
	const isStale = lease.reapableStaleBuild;
	if (isStale) void reapStaleGenerating(row.id);
	if (lease.reapableStrandedEdit) void reapStaleReservation(row.id);
	return {
		id: row.id,
		app_name: row.app_name || UNTITLED_APP_NAME,
		connect_type: row.connect_type,
		module_count: row.module_count,
		form_count: row.form_count,
		status: isStale ? "error" : (row.status as AppDoc["status"]),
		error_type: isStale ? "internal" : row.error_type,
		logo: row.logo,
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
	let query = db.selectFrom("apps").selectAll().where("deleted_at", "is", null);
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
	const rows = (await query.limit(limit).execute()) as AppRow[];
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
		.selectAll()
		.where("project_id", "=", projectId)
		.where("deleted_at", "is not", null)
		.orderBy("deleted_at", "desc")
		.orderBy("id", "asc")
		.limit(options.limit)
		.execute()) as AppRow[];
	const now = Date.now();
	const apps: DeletedAppSummary[] = [];
	for (const row of rows) {
		const recoverableUntil = row.recoverable_until;
		if (!recoverableUntil || recoverableUntil.getTime() <= now) continue;
		const deletedAt = row.deleted_at;
		if (!deletedAt) continue;
		apps.push({
			id: row.id,
			app_name: row.app_name || UNTITLED_APP_NAME,
			connect_type: row.connect_type,
			module_count: row.module_count,
			form_count: row.form_count,
			/* Status pass-through — soft-delete is the existence axis, so a
			 * deleted `error` app keeps its true badge (legacy rows deleted by
			 * the old status-flip flow still carry the literal `"deleted"`). */
			status: row.status as AppDoc["status"],
			error_type: row.error_type,
			logo: row.logo,
			created_at: row.created_at.toISOString(),
			updated_at: row.updated_at.toISOString(),
			deleted_at: deletedAt.toISOString(),
			recoverable_until: recoverableUntil.toISOString(),
		});
	}
	return { apps };
}
