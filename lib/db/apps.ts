/**
 * App CRUD helpers — thin wrappers over Firestore collection/document helpers.
 *
 * Apps live in a root-level `apps/{appId}` collection with an `owner` field
 * storing the user's UUID. Most operations only need the appId — the owner
 * is embedded in the document. List and concurrency queries filter by
 * `owner` with a composite index.
 *
 * All writes extract denormalized fields from the blueprint automatically
 * so list queries never need to deserialize full blueprints.
 */

import type { Firestore } from "@google-cloud/firestore";
import {
	FieldPath,
	FieldValue,
	Timestamp,
	type Transaction,
} from "@google-cloud/firestore";
import Fuse from "fuse.js";
import type { ErrorType } from "@/lib/agent";
import { getAuthDb } from "@/lib/auth/db";
import { log } from "@/lib/logger";
import {
	describeMediaExpectationFailures,
	type MediaAttachExpectation,
} from "@/lib/media/attachVerdicts";
import {
	describeIntroducedErrors,
	mutationCommitVerdict,
} from "../doc/commitVerdicts";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "../doc/fieldParent";
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
	BlueprintCommitRejectedError,
	batchTargetsMissing,
	CommitReauthError,
	reauthorizeActorForCommit,
} from "./commitGuard";
import {
	ACCEPTED_MUTATIONS_TTL_MS,
	BATCH_DEDUP_TTL_MS,
	RETENTION_COUNT,
} from "./constants";
import { refundStaleGeneration, refundStaleReservation } from "./credits";
import {
	collections,
	docs,
	getDb,
	runThrottledTransaction,
	runThrottledWrite,
} from "./firestore";
import { withFirestoreRetry } from "./firestoreRetry";
import { addReferencingApp, getAssetsInTransaction } from "./mediaAssets";
import { editLeaseDeadlineMs, runLeaseState } from "./runLiveness";
import type { AcceptedMutationDoc, AppDoc } from "./types";

// ── Types ──────────────────────────────────────────────────────────

/** Subset of AppDoc fields returned by list queries (no full blueprint). */
export interface AppSummary {
	id: string;
	app_name: string;
	connect_type: AppDoc["connect_type"];
	module_count: number;
	form_count: number;
	status: AppDoc["status"];
	/** App-logo asset id (denormalized from `blueprint.logo`); `null` when unset. */
	logo: string | null;
	/** Error classification string — present only when status is 'error'. */
	error_type: string | null;
	/** ISO 8601 string — Firestore Timestamp converted at the query boundary. */
	created_at: string;
	/** ISO 8601 string — Firestore Timestamp converted at the query boundary. */
	updated_at: string;
}

/**
 * Shape returned by `listDeletedApps` — the standard summary plus the
 * two soft-delete metadata fields, both guaranteed non-null on any row
 * this query returns. `status` is inherited as-is from `AppSummary`:
 * soft-delete and lifecycle status are orthogonal axes, so a deleted
 * `error` app surfaces here with `status: "error"` (and any legacy
 * row written by the old delete flow still surfaces with `status:
 * "deleted"`, until the legacy data is scrubbed).
 *
 * Callers (the trash UI) read `deleted_at` and `recoverable_until` to
 * render "deleted X days ago" and "permanently deletes on DATE" without
 * a second fetch.
 */
export interface DeletedAppSummary extends AppSummary {
	/** ISO-8601 timestamp the app was soft-deleted. */
	deleted_at: string;
	/** ISO-8601 end of the recovery window the trash UI surfaces. */
	recoverable_until: string;
}

/**
 * Narrowed status enum exposed on list/search surfaces.
 *
 * The on-disk `AppDoc["status"]` enum also includes `"deleted"` for
 * legacy rows written by the prior status-flip soft-delete flow.
 * Soft-deletes are filtered server-side via `where("deleted_at", "==",
 * null)`, so callers that want to filter by status reference this
 * narrower type — `"deleted"` is never a legitimate filter argument.
 */
export type AppStatus = Exclude<AppDoc["status"], "deleted">;

/**
 * Sort orders supported by `listApps`.
 *
 * - `"updated_desc"` — most recently modified first; the default.
 * - `"updated_asc"` — oldest first.
 * - `"name_asc"` — alphabetical A→Z, case-insensitive via the
 *   denormalized `app_name_lower` field.
 * - `"name_desc"` — reverse alphabetical Z→A, same field.
 *
 * Pairs exist in both directions for each sort axis so callers never
 * need to preface their request with "sorry, only X is available"
 * caveats. Each sort is backed by one composite index (two when paired
 * with a status filter) — see `firestore.indexes.json`.
 *
 * `searchApps` does not accept a `sort` — Fuse ranks results by relevance,
 * which is the only sensible ordering for a search.
 */
export type AppsSortOrder =
	| "updated_desc"
	| "updated_asc"
	| "name_asc"
	| "name_desc";

/**
 * Structured cursor used to resume enumeration in `listApps`.
 *
 * Discriminated by `kind`, which MUST equal the `sort` the caller is
 * running with — mixing (e.g. paging a `name_asc` list with a cursor
 * minted during an `updated_desc` call) scans the wrong index position
 * and returns nonsense. The server enforces this match and throws rather
 * than silently coerce.
 *
 * The `id` component is the document id — Firestore's implicit tiebreaker
 * on `__name__` makes `(sort_field, id)` a stable composite sort key, so
 * `startAfter(value, id)` resumes exactly where the prior page ended even
 * when two docs share the same sort-field value.
 *
 * The on-the-wire form is produced by `encodeAppsCursor` (base64-encoded
 * JSON); `decodeAppsCursor` is the inverse and validates the shape.
 */
export type ListAppsCursor =
	| { kind: "updated_desc"; updated_at: string; id: string }
	| { kind: "updated_asc"; updated_at: string; id: string }
	| { kind: "name_asc"; name_lower: string; id: string }
	| { kind: "name_desc"; name_lower: string; id: string };

/** Options consumed by `listApps`. */
export interface ListAppsOptions {
	/** Max rows to return. Callers declare — no implicit default at the DB layer. */
	limit: number;
	/** Sort order for the Firestore scan. Callers declare — no implicit default. */
	sort: AppsSortOrder;
	/** Optional status filter. Applied as a Firestore `where` clause. */
	status?: AppStatus;
	/** Opaque cursor from a prior response's `nextCursor`. */
	cursor?: string;
}

/** Shape returned by `listApps`. Pagination cursor is opaque to callers. */
export interface ListAppsResult {
	apps: AppSummary[];
	/**
	 * Present iff Firestore returned exactly `limit` rows on this page —
	 * the "maybe more" signal. Callers pass it back as `options.cursor`
	 * to fetch the next page.
	 *
	 * Soft-deletes are filtered server-side, so `apps.length === limit`
	 * whenever this is set; a present cursor genuinely means more
	 * visible apps may exist.
	 */
	nextCursor?: string;
}

/** Options consumed by `searchApps`. */
export interface SearchAppsOptions {
	/** The search phrase. Required; Fuse performs fuzzy substring matching on `app_name`. */
	query: string;
	/** Max matches to return per call. Callers declare. */
	limit: number;
	/** Optional status filter forwarded to the underlying `listApps` scan. */
	status?: AppStatus;
	/** Opaque cursor from a prior search response's `nextCursor`. */
	cursor?: string;
}

/** Shape returned by `searchApps`. Mirrors `ListAppsResult`. */
export interface SearchAppsResult {
	apps: AppSummary[];
	/**
	 * Present iff the underlying Firestore scan had more pages to examine.
	 * Following the cursor resumes the scan (newest-first) and runs Fuse
	 * on the next batch. The total match count over multiple calls is
	 * bounded by what the user actually has.
	 */
	nextCursor?: string;
}

/**
 * Display name for an app whose `appName` has never been set.
 *
 * The denormalize step writes this string into `app_name` for any row
 * whose in-doc name is blank, so every persisted summary row carries a
 * non-empty name. Exported so downstream callers reference the same
 * literal rather than redeclaring it.
 */
export const UNTITLED_APP_NAME = "Untitled";

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Extract denormalized list-display fields from a normalized doc.
 *
 * Accepts both `PersistableDoc` (on-disk shape without `fieldParent`) and
 * `BlueprintDoc` (in-memory shape with `fieldParent`) so callers can pass
 * either without a conversion step.
 *
 * `moduleOrder.length` gives the module count; summing each module's
 * `formOrder` entry gives the total form count. These are stored on the
 * Firestore document so list queries never need to deserialize a full doc.
 *
 * `app_name_lower` is a sort key, not a display field: Firestore orders
 * fields byte-wise, so without a pre-lowercased copy `orderBy("app_name")`
 * places "ZEbra" before "apple". Writing the lowercase form on every save
 * lets the `name_asc` sort in `listApps` use an index on the denormalized
 * field and get natural case-insensitive ordering for free. The display
 * `app_name` field is preserved exactly so the UI can render the original
 * casing.
 */
function denormalize(doc: PersistableDoc) {
	const formCount = doc.moduleOrder.reduce(
		(sum, modUuid) => sum + (doc.formOrder[modUuid]?.length ?? 0),
		0,
	);
	const appName = doc.appName || UNTITLED_APP_NAME;
	return {
		app_name: appName,
		app_name_lower: appName.toLowerCase(),
		connect_type: doc.connectType ?? null,
		module_count: doc.moduleOrder.length,
		form_count: formCount,
	};
}

/**
 * Maintain the media reverse index for a saved blueprint: record `appId` against
 * every media asset the doc references, so the delete reference guard reads an
 * asset's `referencingAppIds` candidate set instead of loading every one of the
 * owner's apps (a real, measured ~8s on an 83-app account). Two post-commit
 * callers, both outside the transaction: {@link commitGuardedBatch} on a real
 * commit (`!deduped`) — the one write path every editing surface shares — and
 * {@link commitAppProjectMove} when the move repointed the blueprint. It IS
 * denormalization, deriving an index field off the blueprint on write.
 * ({@link appendSyntheticBatchTx} — the migration twin — deliberately does NOT
 * sync: it writes a reload sentinel over non-media structure, and a stale edge
 * it left behind is pruned-by-omission at delete time anyway.)
 *
 * Append-only (see `addReferencingApp`): the guard re-walks each candidate to
 * confirm, so this never needs to REMOVE an app that dropped a reference. A
 * no-media doc (the common case) collects an empty set and writes nothing.
 *
 * Best-effort: a failure here is logged, not thrown. The index is a guard
 * optimization, not the correctness backstop (the media validator still rejects
 * a truly-orphaned reference at export), and `arrayUnion` is idempotent — the
 * next save of this app re-adds the dropped edge, so a transient miss self-heals
 * rather than failing the user's blueprint write. The flip side: the guard is
 * therefore best-effort, not authoritative — a never-re-saved missed edge can
 * let a still-referenced asset be deleted, surfacing only at export (where it is
 * re-uploadable). That is the accepted cost of not re-scanning every app.
 */
async function syncMediaReferences(
	appId: string,
	doc: PersistableDoc,
): Promise<void> {
	try {
		// Real refs only — built-in icon refs (`nova-icon:<slug>`) have no Firestore
		// asset row, so `addReferencingApp` would `update()` a non-existent doc and
		// reject NOT_FOUND on nearly every generated app. They need no reverse index
		// (shared + undeletable, never subject to the deletion guard).
		await addReferencingApp(collectRealAssetRefs(asWalkableDoc(doc)), appId);
	} catch (err) {
		log.error("[syncMediaReferences] reverse-index update failed", err, {
			appId,
		});
	}
}

// ── Concurrency Guard ─────────────────────────────────────────────

/**
 * Check whether the ACTOR has an active generation in progress.
 *
 * Unions two queries, deduped by app id, because the run's ACTOR is
 * recorded in two different places across a build's life:
 *  - `owner == actor` — a brand-new build, BEFORE `reserveCredits` stamps
 *    a `reservation` marker. `createApp` writes the app (`owner = creator
 *    = actor`, `status: generating`) before the route's concurrency check,
 *    so this query is the createApp-as-lock that stops two simultaneous new
 *    builds from both slipping past (a single `reservation.userId` query
 *    misses them — the marker doesn't exist yet — and both would charge).
 *  - `reservation.userId == actor` — a run the actor drives on an app
 *    someone else OWNS (a shared Project co-member building another's app),
 *    where `owner != actor`.
 *
 * An owner-matched app whose `reservation.userId` is a DIFFERENT user is a
 * co-member's run on this user's app — that is the CO-MEMBER's concurrency,
 * not this user's, so it's skipped (it must not falsely block the owner's
 * own build). A marker-less owner match (the new-build window) is kept.
 *
 * Returns `true` if a live generation exists that isn't `excludeAppId` —
 * retries on the same build pass; concurrent new builds are blocked.
 *
 * Best-effort (the chat route treats it fail-open). The reservation's
 * atomic debit remains the true no-overshoot guard; free edit
 * continuations never flip to `generating`, so they never count.
 */
export async function hasActiveGeneration(
	actorUserId: string,
	excludeAppId?: string,
): Promise<boolean> {
	const [byOwner, byActor] = await Promise.all([
		collections
			.apps()
			.where("owner", "==", actorUserId)
			.where("deleted_at", "==", null)
			.where("status", "==", "generating")
			.limit(5)
			.get(),
		collections
			.apps()
			.where("reservation.userId", "==", actorUserId)
			.where("deleted_at", "==", null)
			.where("status", "==", "generating")
			.limit(5)
			.get(),
	]);

	const byId = new Map<string, (typeof byOwner.docs)[number]>();
	for (const doc of byOwner.docs) byId.set(doc.id, doc);
	for (const doc of byActor.docs) byId.set(doc.id, doc);
	if (byId.size === 0) return false;

	const now = Date.now();

	for (const doc of byId.values()) {
		if (doc.id === excludeAppId) continue;
		const data = doc.data() as Partial<AppDoc>;
		/* A co-member's run on THIS user's owned app (owner match but the run
		 * actor is someone else) is the co-member's concurrency, not this
		 * user's — don't let it block the owner's own build. A marker-less
		 * owner match (the new-build window) has no run actor yet and is kept.
		 * (`reservation.userId` is provenance, not a liveness field — read directly.) */
		const runActor = data.reservation?.userId;
		if (runActor !== undefined && runActor !== actorUserId) continue;

		const lease = runLeaseState(data, now);
		/* A LIVE build (inside its staleness window, not paused) is a real
		 * in-progress run — the user has another build running. */
		if (lease.live) return true;
		/* Stale — reap it (refund the stranded hold + flip to error) so a dead build
		 * doesn't block future generations. `reapableStaleBuild` reaps a HARD-KILLED
		 * build AND an ABANDONED PAUSED one whose frozen `updated_at` drifted past the
		 * window (a paused run's own resume re-arms `updated_at`, so a legit
		 * recently-paused build stays fresh and is neither reaped nor counted busy). */
		if (lease.reapableStaleBuild) void reapStaleGenerating(doc.id);
	}

	return false;
}

// ── Existence Check ───────────────────────────────────────────────

/**
 * Lightweight existence check — does the Project have at least one live
 * (non-soft-deleted) app?
 *
 * Uses `limit(1)` with no field projection so it's as cheap as a
 * Firestore read can be. Called by the root page before the Suspense
 * boundary to choose between the get-started state and the app list.
 *
 * The soft-delete filter mirrors `listApps`: a Project whose every app
 * was deleted should land on get-started, not an empty list page.
 */
export async function projectHasApps(projectId: string): Promise<boolean> {
	const snap = await getDb()
		.collection("apps")
		.where("project_id", "==", projectId)
		.where("deleted_at", "==", null)
		.limit(1)
		.get();
	return !snap.empty;
}

// ── CRUD ───────────────────────────────────────────────────────────

/**
 * Optional overrides for `createApp`. Both fields are optional and
 * have defaults that match the most common shape of a new app row.
 */
export interface CreateAppOptions {
	/**
	 * Initial app name. Empty string when unset — list display falls back
	 * to `UNTITLED_APP_NAME`.
	 */
	appName?: string;
	/**
	 * Initial lifecycle status. Limited to the valid creation states:
	 * `"generating"` arms the staleness timer in `listApps` (advanced on
	 * every write; a 10-minute gap self-marks the app as `error`) — the
	 * chat build's run-liveness marker; `"complete"` is the at-rest
	 * default for every other creation (MCP `create_app`, atomic
	 * creations) — an empty app is at rest and valid, and status never
	 * feeds the validity gate.
	 *
	 * `"error"` is excluded — a fresh app has not failed at anything yet.
	 * `"deleted"` is excluded — soft-delete is an out-of-band transition
	 * via `softDeleteApp`, never a creation state.
	 */
	status?: "generating" | "complete";
}

/**
 * Create a new app document.
 *
 * The empty doc uses the normalized `BlueprintDoc` shape with the
 * Firestore document id baked in as `appId` so the doc is
 * self-identifying on load. Denormalized summary fields are derived
 * eagerly from the empty doc + optional overrides so list queries
 * never deserialize a blueprint.
 *
 * See `CreateAppOptions` for the two tunable fields and their defaults.
 */
export async function createApp(
	owner: string,
	projectId: string,
	runId: string,
	opts?: CreateAppOptions,
): Promise<string> {
	const ref = collections.apps().doc();
	const emptyDoc: BlueprintDoc = {
		appId: ref.id,
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
	const persistable = toPersistableDoc(emptyDoc);
	await runThrottledWrite(() =>
		ref.set({
			owner,
			project_id: projectId,
			...denormalize(emptyDoc),
			blueprint: persistable,
			/* The per-app stream counter starts at 0; the guarded writer advances
			 * it by one on every committed mutation batch. */
			mutation_seq: 0,
			status: opts?.status ?? "generating",
			error_type: null,
			/* Initialize soft-delete fields to null so every row on disk
			 * matches the full `appDocSchema` shape and first-soft-delete
			 * writes update existing fields rather than materializing them. */
			deleted_at: null,
			recoverable_until: null,
			run_id: runId,
			created_at: FieldValue.serverTimestamp(),
			updated_at: FieldValue.serverTimestamp(),
		}),
	);
	return ref.id;
}

// ── Blueprint snapshot writer ──────────────────────────────────────
// Every blueprint write goes through `writeCommittedSnapshot` (the
// `getDb()`-bound guarded commits) or `appendSyntheticBatchTx` (the
// migration twin on a passed client). Both build the `update()` payload from
// `blueprintSnapshotFields` — Firestore `update()` replaces the top-level
// `blueprint` map wholesale (with `ignoreUndefinedProperties`, a caller-cleared
// nested key is gone), and each write couples the blueprint + summary write to
// the post-commit `syncMediaReferences` so the delete-reference index can't rot.

/**
 * The blueprint-snapshot field set — the ONE definition of what a
 * blueprint write touches, shared by `writeCommittedSnapshot` and
 * `appendSyntheticBatchTx` so they can't drift on which denormalized fields
 * ride along.
 *
 * Module-private: `writeCommittedSnapshot` is its only `getDb()`-bound caller,
 * and `appendSyntheticBatchTx` (the migration twin, on a passed client) calls
 * it directly. A live tab learns about a migration through the stream's
 * `kind: "migration"` reload sentinel (its next frame → reload).
 */
function blueprintSnapshotFields(
	doc: PersistedBlueprint,
	extra: {
		status?: AppDoc["status"];
		runId?: string;
	} = {},
) {
	return {
		...denormalize(doc),
		blueprint: doc,
		updated_at: FieldValue.serverTimestamp(),
		...(extra.status !== undefined && { status: extra.status }),
		...(extra.runId !== undefined && { run_id: extra.runId }),
	};
}

/**
 * The one `getDb()`-bound blueprint-snapshot write — the shared tail of every
 * guarded commit. On the caller's transaction: replace the blueprint +
 * denormalized summary, advance `mutation_seq` to the
 * caller's LITERAL `seq`, fold in `extraAppFields` (the cross-Project move's
 * `project_id` flip), append the durable `acceptedMutations/{seq}` stream entry
 * + the `batchDedup/{batchId}` idempotency latch (both TTL-stamped), and prune
 * the entry `RETENTION_COUNT` behind the head. The only caller of the private
 * `blueprintSnapshotFields`.
 */
function writeCommittedSnapshot(
	tx: Transaction,
	args: {
		appId: string;
		seq: number;
		batchId: string;
		runId?: string;
		/** The persistable doc to store (already `toPersistableDoc`'d by the
		 *  guarded caller; the cross-Project move passes its persisted doc). */
		committedDoc: PersistedBlueprint;
		mutations: Mutation[];
		actorUserId: string;
		kind: AcceptedMutationDoc["kind"];
		extraAppFields?: Record<string, unknown>;
	},
): void {
	const nowMs = Date.now();
	tx.update(docs.appRaw(args.appId), {
		...blueprintSnapshotFields(
			args.committedDoc,
			args.runId !== undefined ? { runId: args.runId } : {},
		),
		mutation_seq: args.seq,
		...args.extraAppFields,
	});
	tx.set(docs.acceptedMutation(args.appId, args.seq), {
		seq: args.seq,
		batchId: args.batchId,
		...(args.runId !== undefined && { runId: args.runId }),
		mutations: args.mutations,
		actorId: args.actorUserId,
		kind: args.kind,
		ts: FieldValue.serverTimestamp(),
		expireAt: Timestamp.fromMillis(nowMs + ACCEPTED_MUTATIONS_TTL_MS),
	});
	tx.set(docs.batchDedup(args.appId, args.batchId), {
		seq: args.seq,
		expireAt: Timestamp.fromMillis(nowMs + BATCH_DEDUP_TTL_MS),
	});
	// Count-bounded prune: drop the entry `RETENTION_COUNT` behind the head, so a
	// recovering client whose cursor fell off the window reloads a snapshot
	// rather than replaying an unbounded stream. The TTL is the durable floor.
	const pruneSeq = args.seq - RETENTION_COUNT;
	if (pruneSeq > 0) {
		tx.delete(docs.acceptedMutation(args.appId, pruneSeq));
	}
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
	 * A `{ projectId }` the caller ALREADY resolved (`loadAppProjectId`) and
	 * reauthed the actor's role against (`reauthorizeActorForCommit`) moments
	 * ago. When present, the pre-transaction reauth here is skipped — it would
	 * re-run the identical `loadAppProjectId` + `projectRoleFor` round trip for
	 * the same actor. Only the migration-bearing `applyBlueprintChange` path,
	 * which reauths before its Phase-1 DDL, supplies it. The IN-transaction
	 * checks (owner fallback, concurrent-move rejection against this same
	 * `projectId`) remain the authoritative gate either way. Absent: resolve +
	 * reauth here (every other caller).
	 */
	readonly preauthorized?: { readonly projectId: string | null };
}

/** Outcome of {@link commitGuardedBatch}. */
export interface CommitGuardedBatchResult {
	readonly seq: number;
	/**
	 * The committed doc, fully hydrated (`fieldParent` + `refIndex`) — the
	 * verdict's `nextDoc`, so chat/MCP consumers need no re-hydration.
	 */
	readonly committedDoc: BlueprintDoc;
	/** True when the `batchId` was already committed (nothing written). */
	readonly deduped: boolean;
}

/**
 * The unified guarded blueprint commit — the read-evaluate-write every write
 * path (chat, MCP, auto-save, the cross-Project move via
 * {@link commitAppProjectMove}) now shares.
 *
 * Reauth for the common case resolves BEFORE the transaction (out of the retry
 * loop): the actor's role in the app's Project — `null` (not a member) or a
 * role without `edit` rejects. A null `project_id` defers to an in-transaction
 * `owner` check. A caller that already resolved + reauthed (the migration saga)
 * passes `preauthorized` to skip this redundant pre-txn round trip; the in-txn
 * checks stay authoritative. Then one transaction: read the dedup latch + fresh app doc up
 * front; a dedup hit returns the recorded seq + the current committed
 * doc, writing nothing; reauth against the fresh doc (owner fallback, or the
 * fresh `project_id` must still equal the reauthed one — a concurrent move
 * rejects); re-check media expectations against the transaction's read set;
 * rebuild the fresh doc (backfill + fieldParent + refIndex); reject a batch
 * targeting a concurrently-removed entity ({@link batchTargetsMissing}) or one
 * the re-run verdict rejects; advance `mutation_seq` to a LITERAL
 * `(fresh.mutation_seq ?? 0) + 1` (recomputed each retry — never
 * `FieldValue.increment`); and {@link writeCommittedSnapshot}.
 */
export async function commitGuardedBatch(
	args: CommitGuardedBatchArgs,
): Promise<CommitGuardedBatchResult> {
	const { appId, batchId, runId, mutations, actorUserId, kind } = args;
	const mediaExpectations = args.mediaExpectations;

	// Pre-transaction reauth for the common (non-null project) case — the
	// shared {@link reauthorizeActorForCommit} `applyBlueprintChange` also runs
	// before its Postgres DDL, so a deauth'd caller is rejected identically on
	// both paths. A null `project_id` defers to the in-transaction owner check.
	// A caller that ALREADY resolved + reauthed (the migration saga) passes
	// `preauthorized` so this identical round trip isn't paid twice; the in-txn
	// checks below stay the authoritative gate regardless.
	let projectId: string | null;
	if (args.preauthorized !== undefined) {
		projectId = args.preauthorized.projectId;
	} else {
		projectId = await loadAppProjectId(appId);
		await reauthorizeActorForCommit(projectId, actorUserId);
	}

	// The persistable is computed once inside the txn (for `writeCommittedSnapshot`)
	// and carried out on this internal-only field so the post-commit
	// `syncMediaReferences` reuses it instead of re-running `toPersistableDoc` on
	// the same doc. Absent on a dedup hit, which writes nothing and skips the sync.
	type InternalResult = CommitGuardedBatchResult & {
		persistable?: PersistedBlueprint;
	};

	const result = await runThrottledTransaction<InternalResult>(
		getDb(),
		async (tx) => {
			// Read both up front — Firestore forbids reads after the first write.
			const dedupSnap = await tx.get(docs.batchDedupRaw(appId, batchId));
			const appSnap = await tx.get(docs.app(appId));
			const fresh = appSnap.exists ? (appSnap.data() ?? null) : null;
			if (!fresh) {
				throw new Error(
					`[commitGuardedBatch] app document missing for appId=${appId}`,
				);
			}
			// Idempotent replay of an already-committed batch. `committedDoc` is
			// contracted fully hydrated (fieldParent + refIndex); the verdict path
			// returns `nextDoc` carrying both, so the dedup doc builds its refIndex
			// too — via the same `buildReferenceIndex` the hydration boundaries use.
			if (dedupSnap.exists) {
				const latch = dedupSnap.data() as { seq: number };
				const dedupedDoc = hydratePersistedBlueprint(
					fresh.blueprint as PersistableDoc,
				);
				dedupedDoc.refIndex = buildReferenceIndex(dedupedDoc);
				return {
					seq: latch.seq,
					committedDoc: dedupedDoc,
					deduped: true,
				};
			}
			// Reauth against the FRESH doc: a null project_id defers to owner (a
			// non-owner is TERMINAL — no membership to gain by reloading); a
			// non-null must still equal the reauthed project. A concurrent MOVE
			// flipped it → RETRYABLE (the actor may be a member of the
			// destination, so reload + re-reauth against the moved app can land).
			if (projectId === null) {
				if (fresh.owner !== actorUserId) {
					throw new CommitReauthError(
						"You don't have edit access to this app.",
					);
				}
			} else if (fresh.project_id !== projectId) {
				throw new BlueprintCommitRejectedError(
					"This app moved to a different Project while you were editing. Reload to get the latest state.",
				);
			}
			// Media-attach expectations re-check (reads asset rows via `tx`, so a
			// racing delete serializes against this commit) — before any write.
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
			const freshDoc = hydratePersistedBlueprint(
				fresh.blueprint as PersistableDoc,
			);
			if (batchTargetsMissing(freshDoc, mutations)) {
				throw new BlueprintCommitRejectedError(
					"This app changed while you were editing — something your change " +
						"targeted was removed by someone else. Reload to get the latest " +
						"version, then redo that change.",
				);
			}
			const verdict = mutationCommitVerdict(freshDoc, mutations);
			if (!verdict.ok) {
				throw new BlueprintCommitRejectedError(
					describeIntroducedErrors(verdict.introduced),
				);
			}
			const seq = (fresh.mutation_seq ?? 0) + 1;
			const persistable = toPersistableDoc(verdict.nextDoc);
			/* Refresh the EDIT `run_lock` lease on activity — the run-lock analogue of
			 * how a build advances `updated_at` on every commit. An edit can legitimately
			 * run longer than the fixed `MAX_RUN_MINUTES` lease (Cloud Run's ceiling is
			 * far higher), so a live edit must extend its lease as it commits or its lease
			 * would lapse and the reaper would free the app mid-run (releasing the lock a
			 * co-member could then claim → two SA loops). Fires only when THIS commit's
			 * run OWNS the edit lock
			 * (`runLeaseState().mine` — routed through the one reader) — a build commit
			 * (`mode !== "edit"`) or a commit from a different run never touches it, and a
			 * HARD-KILLED edit (no more commits) lets the lease lapse in ~15min and become
			 * claimable, exactly as intended. A dotted `run_lock.expireAt` update extends
			 * just that nested field, leaving the rest of the lock intact. This is the
			 * per-COMMIT lease refresh; the per-STEP + wall-clock-TIMER heartbeats
			 * (`refreshEditLease`) cover an edit that commits infrequently. */
			const commitLease =
				runId !== undefined ? runLeaseState(fresh) : undefined;
			const ownsEditLock =
				runId !== undefined &&
				commitLease?.mode === "edit" &&
				commitLease?.mine(runId);
			const refreshLease = ownsEditLock
				? {
						"run_lock.expireAt": Timestamp.fromMillis(editLeaseDeadlineMs()),
					}
				: undefined;
			writeCommittedSnapshot(tx, {
				appId,
				seq,
				batchId,
				runId,
				committedDoc: persistable,
				mutations,
				actorUserId,
				kind,
				...(refreshLease && { extraAppFields: refreshLease }),
			});
			return {
				seq,
				committedDoc: verdict.nextDoc,
				deduped: false,
				persistable,
			};
		},
	);

	// Post-commit media reverse-index sync — best-effort, only on a real commit
	// (`persistable` is present exactly then, reusing the txn's `toPersistableDoc`).
	if (!result.deduped && result.persistable !== undefined) {
		await syncMediaReferences(appId, result.persistable);
	}
	const { persistable: _persistable, ...publicResult } = result;
	return publicResult;
}

/**
 * The migration-client twin of the guarded commit: advance an app's blueprint +
 * `mutation_seq` + durable stream + dedup latch on a PASSED Firestore client (a
 * `--project`-pinned migration runs off its own client, not the `getDb()`
 * singleton), so a live builder tab's next auto-save 409-reloads onto the
 * migrated state instead of overwriting it. One transaction, every ref built
 * from `db` directly — never the `getDb()`-bound `docs.*` helpers or
 * {@link writeCommittedSnapshot}. The `acceptedMutations/{seq}` entry is a
 * RELOAD SENTINEL (`mutations: []`): a recovering client can't replay an empty
 * batch, so it reloads the snapshot — exactly right for a wholesale migration.
 */
export async function appendSyntheticBatchTx(
	db: Firestore,
	appId: string,
	migratedDoc: PersistedBlueprint,
): Promise<void> {
	const appRef = db.collection("apps").doc(appId);
	const batchId = crypto.randomUUID();
	const nowMs = Date.now();
	await db.runTransaction(async (tx) => {
		const snap = await tx.get(appRef);
		const fresh = snap.exists ? (snap.data() ?? null) : null;
		if (!fresh) {
			throw new Error(
				`[appendSyntheticBatchTx] app document missing for appId=${appId}`,
			);
		}
		const seq = ((fresh.mutation_seq as number | undefined) ?? 0) + 1;
		tx.update(appRef, {
			...blueprintSnapshotFields(migratedDoc),
			mutation_seq: seq,
		});
		tx.set(
			appRef.collection("acceptedMutations").doc(String(seq).padStart(12, "0")),
			{
				seq,
				batchId,
				mutations: [],
				actorId: "migration",
				kind: "migration",
				ts: FieldValue.serverTimestamp(),
				expireAt: Timestamp.fromMillis(nowMs + ACCEPTED_MUTATIONS_TTL_MS),
			},
		);
		tx.set(appRef.collection("batchDedup").doc(batchId), {
			seq,
			expireAt: Timestamp.fromMillis(nowMs + BATCH_DEDUP_TTL_MS),
		});
	});
}

/**
 * Outcome of {@link commitAppProjectMove}. `moved` and `already_moved` are both
 * terminal success (the latter idempotent — a re-run after the flip committed);
 * `media_stale` reports asset ids the FRESH doc references that the caller never
 * attempted to copy into the destination (a concurrent edit added them after the
 * orchestrator's copy pass), so the move orchestrator copies those and retries.
 */
export type CommitMoveResult =
	| { kind: "moved" }
	| { kind: "already_moved" }
	| { kind: "media_stale"; missing: string[] }
	| { kind: "busy" };

/**
 * The single write that changes an app's `project_id` — the commit point of a
 * cross-Project move (`lib/db/moveAppToProject.ts`). In one transaction over the
 * fresh app doc it repoints the blueprint's media refs onto the destination
 * copies (`assetIdMap`, built by the move's media step) and flips `project_id`,
 * so a co-editor's stale tab 409-reloads (its next PUT's in-transaction
 * `project_id` compare rejects — see `commitGuardedBatch`) and the
 * blueprint never spends an instant referencing destination-absent media.
 *
 * Reads fresh and folds the remap into the same transaction (rather than routing
 * through `applyBlueprintChange`) because a move touches no case TYPES — the
 * case-store schema is unaffected — so there is no schema saga to run, and
 * keeping remap + flip atomic is what removes the media-broken window.
 *
 * `attemptedRealIds` is the set of non-builtin asset ids the caller ran the
 * media-copy over; any non-builtin ref in the fresh doc OUTSIDE that set is a
 * concurrently-added ref the copy never saw, returned as `media_stale` so the
 * caller re-copies and retries rather than committing a destination-broken ref.
 * Because this writes nothing in that case (and the move re-tenants case rows
 * only AFTER a successful flip), an aborted commit leaves the app fully untouched
 * — there is no forced-through "land it broken" path. Refs the caller attempted
 * but couldn't copy (a still-`pending` upload, a foreign ref) are NOT reported —
 * they were already broken/pending and the destination inherits that same state.
 */
export async function commitAppProjectMove(
	appId: string,
	args: {
		toProjectId: string;
		expectedFromProjectId: string;
		assetIdMap: ReadonlyMap<string, string>;
		attemptedRealIds: ReadonlySet<string>;
	},
): Promise<CommitMoveResult> {
	const batchId = crypto.randomUUID();
	const result = await runThrottledTransaction<{
		outcome: CommitMoveResult;
		committed: PersistedBlueprint | null;
	}>(getDb(), async (tx) => {
		const snap = await tx.get(docs.app(appId));
		const fresh = snap.exists ? (snap.data() ?? null) : null;
		if (!fresh) {
			throw new Error(
				`[commitAppProjectMove] app document missing for appId=${appId}`,
			);
		}
		// Already at the destination: a re-run after a completed commit. No-op.
		if (fresh.project_id === args.toProjectId) {
			return { outcome: { kind: "already_moved" }, committed: null };
		}
		// Source changed under us (another move landed first). The caller
		// re-resolves authorization rather than overwriting that move.
		if (fresh.project_id !== args.expectedFromProjectId) {
			throw new Error(
				`[commitAppProjectMove] source Project changed for appId=${appId} (expected ${args.expectedFromProjectId}, found ${fresh.project_id ?? "null"})`,
			);
		}
		// A build that started after the caller's authz read would, on its next
		// blueprint save, blind-overwrite the repoint we're about to write while
		// leaving project_id flipped — breaking the moved app's media. Re-check
		// status against the FRESH doc so the bar is atomic with the flip.
		if (fresh.status === "generating") {
			return { outcome: { kind: "busy" }, committed: null };
		}
		const missing = collectRealAssetRefs(asWalkableDoc(fresh.blueprint)).filter(
			(id) => !args.attemptedRealIds.has(id),
		);
		if (missing.length > 0) {
			// A ref the copy never saw (a concurrent edit added it). Write nothing
			// and report it so the caller re-copies + retries; the move re-tenants
			// case rows only after a successful flip, so this leaves the app intact.
			return { outcome: { kind: "media_stale", missing }, committed: null };
		}

		// Both success branches route the single `appRaw` write through
		// `writeCommittedSnapshot`, advancing `mutation_seq` + appending the stream
		// entry / dedup latch, so a source-Project co-editor's stale tab 409-reloads
		// (its next PUT's in-transaction `project_id` compare rejects) rather than
		// blind-overwriting the flip. The move is a migration-class commit with an
		// empty mutation delta.
		const seq = (fresh.mutation_seq ?? 0) + 1;
		if (args.assetIdMap.size > 0) {
			const remapped = remapAssetRefs(fresh.blueprint, args.assetIdMap);
			writeCommittedSnapshot(tx, {
				appId,
				seq,
				batchId,
				committedDoc: remapped,
				mutations: [],
				actorUserId: "migration",
				kind: "migration",
				extraAppFields: { project_id: args.toProjectId },
			});
			return { outcome: { kind: "moved" }, committed: remapped };
		}
		// No media to repoint — the blueprint is unchanged; re-stamp the fresh
		// snapshot and flip `project_id` in the same write.
		writeCommittedSnapshot(tx, {
			appId,
			seq,
			batchId,
			committedDoc: fresh.blueprint,
			mutations: [],
			actorUserId: "migration",
			kind: "migration",
			extraAppFields: { project_id: args.toProjectId },
		});
		return { outcome: { kind: "moved" }, committed: null };
	});

	// Index the destination assets against the app, same best-effort contract as
	// every other writer's post-commit sync. Only needed when the blueprint was
	// repointed (the no-media flip references the same assets it already did).
	if (result.committed) {
		await syncMediaReferences(appId, result.committed);
	}
	return result.outcome;
}

/**
 * Clean BUILD completion — flip `generating → complete` AND settle the run's
 * kept-charge reservation marker in ONE transaction. The one drain-end build
 * finalizer (there is no status-only variant — a status flip that didn't settle
 * atomically is the exact window that clawed back a kept charge).
 *
 * The atomicity is load-bearing. `status: 'complete'` (with no `run_lock`) is
 * what makes the app CLAIMABLE, and a settled marker is what tells the reaper +
 * the next `reserveCredits` "this charge was kept, don't refund it." Doing them
 * as two separate writes (a status flip then a later settle) opens a window: the
 * instant status flips to `complete` the app is claimable, and an edit POST
 * landing before the settle wins `claimRun('edit')` and its `reserveCredits` sees
 * the build's still-unsettled marker and (per the unconditional leftover-refund)
 * claws back the build's KEPT 100 credits. One transaction closes it — the moment
 * the build is claimable, its charge is already settled.
 *
 * A hard kill BEFORE this transaction leaves the app `generating` with an
 * unsettled marker → `reapStaleGenerating` (the build reaper) refunds it, which
 * is correct (the build never finished). AFTER → complete + settled + kept.
 *
 * Settles WHATEVER unsettled marker is on the app (the `askQuestions` flow is
 * multi-POST, so the kept charge may have been booked by an earlier POST). The
 * ownership gate (`terminalWriteOwned` = `markerSettleable && mine`) makes a
 * reaped-then-RE-CLAIMED build's stale completion no-op instead of clobbering
 * the taker. A reaped-but-UNCLAIMED build (the false-reap: a live run whose
 * clock lapsed was refunded + flipped to `error`, then finished cleanly) takes
 * the SELF-HEAL branch instead — `status: "error"` + `mode: "none"` +
 * `lease.reaperResolved` (the reaper's settled/`runId`-cleared marker
 * signature) flips the row back to `complete` without touching the marker, so
 * the celebration and the dashboard agree; the reaper's refund stands.
 * Awaited so the route's `data-done` follows the durable flip (a page load right
 * after the celebration never sees a still-`generating` row and bounce off the
 * build page's redirect). `error_type` clears alongside so a retried build's
 * stale classification doesn't linger.
 */
export async function completeAndSettleRun(
	appId: string,
	runId: string,
): Promise<void> {
	await withFirestoreRetry(() =>
		runThrottledTransaction(getDb(), async (tx) => {
			// RAW ref (converter-less): this only needs the run-liveness leaves, and a
			// converter read would re-parse the whole blueprint through Zod — a doc
			// that fails `appDocSchema.parse` would THROW inside the txn, stranding the
			// status flip + settle.
			const snap = await tx.get(docs.appRaw(appId));
			const fresh = (snap.exists ? snap.data() : undefined) as
				| Partial<AppDoc>
				| undefined;
			if (!fresh) return;
			const lease = runLeaseState(fresh);
			// OWNERSHIP GATE (re-checked at WRITE time, in the txn — the stale
			// `heldApp` flag set at claim is not enough). A build's clean completion
			// acts ONLY on an UNSETTLED marker it OWNS (`terminalWriteOwned` = build:
			// `markerSettleable && mine`). It guards the one race that survives without
			// a barge: a long no-commit build whose `updated_at` went stale mid-run is
			// REAPED (flipped to `error` + settled) and the freed app RE-CLAIMED by
			// another run before this completion lands — the reaper settled the marker
			// (or the taker overwrote its `runId`), so `markerSettleable && mine` is
			// false and this no-ops rather than clobbering the new run. Every build
			// reaching here reserved (a build POST is chargeable), so a legit live one
			// always has an unsettled marker.
			if (lease.mode !== "build" || !lease.terminalWriteOwned(runId)) {
				/* FALSE-REAP SELF-HEAL. A live build whose clock lapsed mid-run (the
				 * heartbeat missed, or a pre-heartbeat row) was REAPED — refunded,
				 * marker `runId`-cleared, flipped to `error` — yet the process
				 * survived, kept committing (commits are not status-gated), and
				 * finished cleanly. Without this, the run celebrates + emits
				 * `data-done` over a row the dashboard shows as a FAILED build.
				 * `reaperResolved` (settled marker, `runId` cleared) is the reaper's
				 * signature, `mode: "none"` + `status: "error"` proves nothing holds
				 * the freed app NOW, and `fresh.run_id === runId` proves the app's
				 * LAST COMMITTED batch is THIS run's — the run-specific discriminator
				 * the runId-cleared marker can't provide. Without it, a zombie whose
				 * reaped marker was later JOINED by a second reaped run (re-claim +
				 * hard-kill, marker runId-cleared again) would flip that OTHER run's
				 * failure to `complete` over content that isn't its own; with it, the
				 * heal fires only when the finished run's commits are what the row
				 * actually holds. The reaper's refund stands: the finished build is
				 * kept free rather than re-charged. */
				if (
					fresh.status === "error" &&
					lease.mode === "none" &&
					lease.reaperResolved &&
					fresh.run_id === runId
				) {
					tx.set(
						docs.appRaw(appId),
						{ status: "complete", error_type: null },
						{ merge: true },
					);
				}
				return;
			}
			const reservation = fresh.reservation as NonNullable<
				AppDoc["reservation"]
			>;
			tx.set(
				docs.appRaw(appId),
				{
					status: "complete",
					error_type: null,
					reservation: { ...reservation, settled: true },
				},
				{ merge: true },
			);
		}),
	);
}

/**
 * Thrown by `claimRun` when the app's run window is already held at the
 * transaction's read — a live build (`status: 'generating'` inside the
 * staleness window, not paused) OR a live edit (`run_lock` present, not past
 * its `expireAt`) owns the app, so THIS contender must not run. The chat route
 * no longer 429s this: it opens the SSE stream and waits inside `execute` (a
 * second collaborator's request serializes behind the holder rather than
 * bouncing), taking the claim once the holder releases.
 */
export class RunConflictError extends Error {
	/**
	 * Whether the blocking run was REAPABLE at the claim's read — a lapsed-lease
	 * PAUSED run (`paused` blocks a claim regardless of the lease, so only a
	 * reaper can free it). `claimRun` fires the matching reaper off these flags
	 * before rethrowing: the reapers otherwise fire only from the app-list scan
	 * (`projectAppSummary`) and the build-only `hasActiveGeneration`, neither of
	 * which a collaborator's serialize-with-wait poll touches — without the nudge
	 * an abandoned paused run would block every waiter until a Project member
	 * happened to load the dashboard.
	 */
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
 * The EXACT at-rest values `claimRun` overwrote — a verbatim snapshot of the
 * run-liveness fields the claim mutated, captured off the fresh doc BEFORE the
 * claim write. `restoreClaimedRun` writes these back unchanged to revert the
 * claim, so a bailed claim (a post-claim gate rejection) returns the app to
 * precisely the shape it found. A claim only ever runs on a FREE app — `complete`
 * / `error` at rest, or a HARD-KILLED run (a stale `generating` row / a
 * lease-lapsed lock, neither live nor paused); a live OR paused run blocks the
 * claim (`RunConflictError`), so a bailed claim never has to restore a running
 * peer.
 *
 * Captures EVERY field a claim writes (except the reservation marker, below):
 * `status` + `error_type` (build claim flips these; edit claim normalizes
 * `status → complete`, so both can move them), `awaiting_input` (both claims
 * clear it), `run_lock` (build claim deletes it; edit claim overwrites it), AND
 * `updated_at` (both claims stamp a fresh server timestamp). `updated_at` MUST
 * be captured + reverted verbatim: a bailed claim that re-stamped it fresh would
 * (a) re-arm the ~10-min `generating` staleness clock on a reverted stale-build
 * displacement → a phantom "in progress" that rejects every retry for 10 min,
 * and (b) reorder a plain `complete`/`error` app to the top of every member's
 * recently-updated list though nothing ran. `reservation` is NOT captured: a
 * claim NEVER touches the reservation marker (a displaced hard-killed run's
 * stranded hold is handed back by THIS run's own `reserveCredits` leftover-refund,
 * not by the claim), so there is nothing to revert.
 */
export interface PriorRunState {
	status: AppDoc["status"];
	error_type: string | null;
	/** Whether `awaiting_input` was set (a paused run). */
	awaiting_input: boolean;
	/** The exact prior `run_lock`, or `null` if the app had none. */
	run_lock: AppDoc["run_lock"] | null;
	/** The exact prior `updated_at` — reverted verbatim (NOT re-stamped) so a
	 *  bailed claim doesn't re-arm staleness or reorder the list. */
	updated_at: AppDoc["updated_at"];
}

/**
 * What `claimRun` returns: the claim `mode` (still read by the route for the
 * onFinish stranded-lock release) plus the {@link PriorRunState} snapshot the
 * bail-out restore reverts to.
 */
export interface ClaimedRun {
	mode: "build" | "edit";
	prior: PriorRunState;
}

// Run liveness / ownership / paused / settled is derived ONLY through
// `runLeaseState` (`./runLiveness`) — see its header for the single-reader
// invariant. `claimRun`'s busy check is `lease.live || lease.paused` (a live hold
// OR a paused run of either mode blocks — a paused run is not a takeover), and
// ownership is `lease.mine(runId)`. There are no per-mode `buildHolds` /
// `editHolds` / `isPausedRun` predicates — a decision that read a raw liveness
// field independently is what the single-reader invariant physically prevents.

/**
 * Claim the app's run window for `mode` — the per-app serialization primitive
 * for BOTH SA modes.
 *
 * The app is BUSY when it is `runLeaseState(fresh).live || .paused` — a live hold
 * of EITHER mode OR a paused run (a paused run is NO LONGER a claimable takeover
 * — that whole class was descoped). A claim of either mode on a busy app throws
 * {@link RunConflictError} with nothing written; the route serializes-with-wait
 * (polls until the holder completes / fails / is reaped, then re-claims). Only a
 * FREE app falls through: `complete` / `error` at rest, or a HARD-KILLED run (a
 * stale `generating` row / a lease-lapsed lock, neither live nor paused). Because
 * a live/paused run always blocks, a claim NEVER displaces a run with a running
 * process — so it NEVER mutates a prior run's marker/lock, which deletes the
 * barge/displacement credit-transfer class (and its [claim, reserveCredits)
 * window) by construction.
 *
 * **Build claim** (`mode: 'build'`) — flip the row to `generating` with a FRESH
 * `updated_at` (the build's liveness horizon), clearing `error_type`, the
 * `awaiting_input` flag, AND any stale `run_lock` a hard-killed prior edit left.
 * The fresh timestamp matters — the row's old `updated_at` belongs to a dead
 * prior run and may already sit outside the staleness window, so without
 * re-arming a concurrent list scan could reap the new run at birth. The claim
 * does NOT touch the reservation MARKER: a displaced hard-killed run's stranded
 * hold is handed back by THIS run's own `reserveCredits` (its unconditional
 * leftover-refund) before it books its fresh marker.
 *
 * **Edit claim** (`mode: 'edit'`) — write `run_lock` `{ runId, actorUserId,
 * expireAt: now + MAX_RUN_MINUTES }`, clear `awaiting_input`, and NORMALIZE
 * `status → complete` + `error_type → null`. The status normalize is an edit's
 * postcondition guarantee: an edit's clean finalize (`clearRunLockAndSettle`)
 * never touches status, so an edit that claimed a stale `generating` row (a
 * hard-killed build) would otherwise complete onto a `generating` row that
 * `reapStaleGenerating` flips to `error` — bricking a cleanly-edited app. The
 * common case (app already `complete`) is a no-op. A stale row's stranded build
 * hold is handed back by this run's own `reserveCredits`; the marker is otherwise
 * left alone.
 *
 * The chat route awaits this before its concurrency check — the same
 * write-then-check ordering `createApp` uses (the durable claim IS the lock).
 * The compare-and-flip is what arbitrates same-app contenders that
 * `hasActiveGeneration` can't (it excludes the contender's own appId).
 *
 * Returns `{ mode, prior }` — the claim mode plus the {@link PriorRunState}
 * snapshot of the exact fields it overwrote, for a faithful bail-out restore.
 */
export async function claimRun(
	appId: string,
	mode: "build" | "edit",
	runId: string,
	actorUserId: string,
): Promise<ClaimedRun> {
	try {
		return await claimRunTx(appId, mode, runId, actorUserId);
	} catch (err) {
		/* A conflict with a REAPABLE holder — an abandoned PAUSED run whose lease
		 * lapsed (`paused` blocks a claim regardless of the lease, so it can only
		 * be freed by a reaper). Run the matching reaper here, on the waiter's own
		 * path: the reapers otherwise fire only from the app-list scan, which a
		 * collaborator polling this claim never touches — so an abandoned paused
		 * run would block every waiter's poll window forever. Awaited (not
		 * fire-and-forget) so the caller's NEXT poll deterministically finds the
		 * freed app; each reaper re-validates its staleness in-txn and swallows its
		 * own faults, so a spurious or repeated fire no-ops and never masks the
		 * conflict. */
		if (err instanceof RunConflictError) {
			if (err.reapableStaleBuild) await reapStaleGenerating(appId);
			else if (err.reapableStrandedEdit) await reapStaleReservation(appId);
		}
		throw err;
	}
}

/** The claim transaction body of {@link claimRun} — split out so the reap
 *  nudge above stays outside the transaction (a txn body must stay pure of
 *  side effects; it can retry). */
async function claimRunTx(
	appId: string,
	mode: "build" | "edit",
	runId: string,
	actorUserId: string,
): Promise<ClaimedRun> {
	return await runThrottledTransaction(getDb(), async (tx) => {
		// RAW ref (converter-less): `claimRun` reads only top-level run-liveness
		// fields (status / error_type / awaiting_input / run_lock / updated_at), so
		// a converter parse of the whole blueprint is both
		// wasteful and a hazard — a doc that fails `appDocSchema.parse` would THROW
		// inside the claim txn, blocking EVERY claim on that app.
		const snap = await tx.get(docs.appRaw(appId));
		const fresh = (snap.exists ? (snap.data() ?? null) : null) as AppDoc | null;
		if (!fresh) {
			throw new Error(`[claimRun] app document missing for appId=${appId}`);
		}

		/* Busy check — a claim SUCCEEDS only on a FREE app. Busy is `live || paused`:
		 * a LIVE hold of either mode blocks (as always), AND a PAUSED run now ALSO
		 * blocks — a paused run is NO LONGER a claimable takeover. A second request
		 * (build OR edit) on a busy app serializes-with-wait (the route polls
		 * `claimRun` up to the wait cap, then "still busy — try again"); the app
		 * frees when the holder completes/fails (its own terminal path) or is reaped
		 * (a hard kill / an abandoned paused run whose lease lapses). A genuine
		 * same-run continuation of a paused run is the RESUME path (`reacquireLease`),
		 * which re-establishes its OWN lease and never re-claims. Only a FREE app
		 * (`mode: none`, or a hard-killed run past its horizon — not live, not paused)
		 * falls through to the claim arms below; because a live/paused run always
		 * blocks, a claim NEVER displaces a run with a running process, so it never
		 * mutates a prior run's marker/lock (a hard-killed run's stranded hold is
		 * handed back by THIS run's own `reserveCredits` leftover-refund, not here).
		 * That is what deletes the barge/displacement credit-transfer class — and its
		 * [claim, reserveCredits) window — by construction. */
		const lease = runLeaseState(fresh);
		if (lease.live || lease.paused) {
			// Carry the reapable flags out so the wrapper can fire the matching
			// reaper for an abandoned paused holder (lapsed lease) — see claimRun.
			throw new RunConflictError(
				lease.reapableStaleBuild,
				lease.reapableStrandedEdit,
			);
		}

		/* The exact at-rest values this claim is about to overwrite — captured
		 * BEFORE any write so a bail-out `restoreClaimedRun` can revert verbatim
		 * (see {@link PriorRunState}). */
		const prior: PriorRunState = {
			status: fresh.status,
			error_type: fresh.error_type ?? null,
			awaiting_input: !!fresh.awaiting_input,
			run_lock: fresh.run_lock ?? null,
			updated_at: fresh.updated_at,
		};

		if (mode === "edit") {
			/* Edit lease — write a fresh `run_lock` (overwriting any STALE lock a
			 * hard-killed prior edit left; the busy check only let a FREE app through,
			 * so this can never overwrite a LIVE lock). `awaiting_input` is cleared
			 * (a fresh claim is never paused).
			 *
			 * `status → complete` + `error_type → null` are NORMALIZED here: an edit's
			 * postcondition is a `complete` app, and its clean finalize
			 * (`clearRunLockAndSettle`) never touches status — so if this edit claimed a
			 * stale `generating` row (a hard-killed build) or an `error` row, leaving
			 * the status/classification would either let the edit complete onto a
			 * `generating` row that `reapStaleGenerating` flips to `error` (bricking a
			 * cleanly-edited app) or leave a `complete` app carrying a stale
			 * `error_type` (breaking `projectAppSummary`'s "error_type present only when
			 * status===error" contract). Nulling both guarantees a clean `complete` app.
			 * (The common case is already `complete` with no error_type, a no-op.) A
			 * stale row's stranded build hold is handed back by this run's own
			 * `reserveCredits` leftover-refund; the marker is otherwise left alone. */
			tx.update(docs.appRaw(appId), {
				status: "complete",
				error_type: null,
				run_lock: {
					runId,
					actorUserId,
					expireAt: Timestamp.fromMillis(editLeaseDeadlineMs()),
				},
				awaiting_input: false,
			});
			return { mode: "edit", prior };
		}

		/* Build claim — flip the app to a live `generating` run with a FRESH
		 * `updated_at` (the build's liveness horizon; the row's old timestamp belongs
		 * to a hard-killed prior run and may already be stale, so without re-arming a
		 * concurrent list scan could reap the new run at birth). Clear `error_type` +
		 * `awaiting_input`, and delete any STALE `run_lock` a hard-killed prior edit
		 * left (the busy check only let a FREE app through, so this never deletes a
		 * LIVE lock). The claim does NOT touch the reservation MARKER: a prior run's
		 * stranded unsettled hold is handed back by THIS run's own `reserveCredits`
		 * (its unconditional leftover-refund) before it books the fresh marker. Since
		 * a live/paused run always blocks the claim, the only prior run this ever
		 * displaces is HARD-KILLED (no running process), so there is no concurrent
		 * writer and no [claim, reserveCredits) window — the barge/displacement class
		 * is gone by construction. */
		tx.update(docs.appRaw(appId), {
			status: "generating",
			error_type: null,
			awaiting_input: false,
			updated_at: FieldValue.serverTimestamp(),
			run_lock: FieldValue.delete(),
		});
		return { mode: "build", prior };
	});
}

/**
 * Refresh a live EDIT run's `run_lock` lease off SA ACTIVITY — the per-STEP
 * heartbeat, complementing the per-COMMIT refresh inside `commitGuardedBatch`.
 *
 * The per-commit refresh alone leaves a gap: an edit doing an extended READ-ONLY
 * stretch (many `search_blueprint` / `get_field` calls, a long model turn)
 * before its first commit would let the 15-min lease lapse → its lease reads dead
 * → `reapStaleReservation` frees the app mid-run (refunds the live hold + releases
 * the lock a co-member could then claim). Heartbeating off SA activity (per-step, debounced) AND a wall-clock
 * TIMER (so a single long no-step model turn can't lapse either) keeps a live
 * edit's lease fresh; a hard-killed edit (no more activity) still lapses in
 * ~`MAX_RUN_MINUTES` and is reaped — so the hard-kill recovery window is
 * unchanged (this does NOT lengthen the lease).
 *
 * Transactionally OWNERSHIP-GATED via `runLeaseState().mine(runId)`: extends the
 * lease ONLY if this run still OWNS it — so a run superseded mid-way (a co-member
 * took over, overwriting the lock's `runId`) never extends the taker's lease, and
 * a build (no `run_lock`) is a clean no-op. Fire-and-forget at the call site. A
 * thrown write bubbles to the caller's `.catch`.
 */
export async function refreshEditLease(
	appId: string,
	runId: string,
): Promise<void> {
	await runThrottledTransaction(getDb(), async (tx) => {
		const snap = await tx.get(docs.appRaw(appId));
		const fresh = (snap.exists ? snap.data() : undefined) as
			| Partial<AppDoc>
			| undefined;
		const lease = fresh ? runLeaseState(fresh) : undefined;
		// Only an EDIT run that this run still owns has a lease to extend (a build
		// holds via `status`, not a lock, so `mode !== "edit"` → no-op).
		const ownsEditLock = lease?.mode === "edit" && lease?.mine(runId);
		if (!ownsEditLock) return;
		tx.update(docs.appRaw(appId), {
			"run_lock.expireAt": Timestamp.fromMillis(editLeaseDeadlineMs()),
		});
	});
}

/**
 * Refresh a live BUILD run's liveness clock (`updated_at`) off SA activity —
 * the build-mode twin of {@link refreshEditLease}, fired by the same per-step
 * + wall-clock heartbeats in `GenerationContext`.
 *
 * A build's liveness horizon is `updated_at` inside `MAX_GENERATION_MINUTES`.
 * Every commit stamps it (`writeCommittedSnapshot`), but a live build can
 * legitimately go longer than the window with NO commit — a long planning /
 * document-extraction / reasoning stretch, or an SA loop whose rejected tool
 * calls persist nothing — and a concurrent scan (or a waiter's claim-conflict
 * nudge) would then reap the LIVE run: refund its hold + flip it to `error`
 * out from under a build that goes on to finish. The heartbeat keeps a live
 * build fresh; a hard-killed one stops beating and still lapses inside the
 * unchanged ~`MAX_GENERATION_MINUTES` window, and an abandoned PAUSED build
 * never beats (its run finalized, stopping the heartbeat), so it lapses and
 * reaps exactly as the descoped model intends.
 *
 * Transactionally OWNERSHIP-GATED via the one liveness reader: a build owns
 * via its reservation marker's `runId`, so a superseded/reaped run never
 * re-arms the clock on an app it no longer holds; the pre-reservation window
 * (claim → `reserveCredits`) reads unowned and no-ops — harmless, the claim
 * itself just stamped a fresh `updated_at`.
 */
export async function refreshBuildLiveness(
	appId: string,
	runId: string,
): Promise<void> {
	await runThrottledTransaction(getDb(), async (tx) => {
		const snap = await tx.get(docs.appRaw(appId));
		const fresh = (snap.exists ? snap.data() : undefined) as
			| Partial<AppDoc>
			| undefined;
		const lease = fresh ? runLeaseState(fresh) : undefined;
		const ownsBuild = lease?.mode === "build" && lease?.mine(runId);
		if (!ownsBuild) return;
		tx.update(docs.appRaw(appId), {
			updated_at: FieldValue.serverTimestamp(),
		});
	});
}

/**
 * Release an edit run's `run_lock` WITHOUT touching the reservation marker — for
 * the terminal states that are NOT a clean kept-charge completion: a FAILED edit
 * (its marker was already refunded+settled by the failure funnel before this
 * releases the lock), a pre-stream bail-out RESTORE (nothing was reserved), and
 * the `onFinish` release of a prelude-throw-stranded lock (a hard kill; its
 * marker, if any, is refunded by the reaper). The clean kept-charge completion
 * uses {@link clearRunLockAndSettle} instead, which releases AND settles
 * atomically.
 *
 * Merge-set with a field delete so it can't disturb `status` / blueprint / the
 * reservation marker. Fire-and-forget like `failApp` (an edit terminal state
 * must not block on Firestore); a dropped clear degrades to the lock expiring at
 * `expireAt`, which the next `claimRun` treats as claimable anyway. A PAUSED
 * edit keeps its lock — the run is alive (a later POST resumes it) — so its
 * caller gates on not-paused.
 */
export function clearRunLock(appId: string): Promise<void> {
	return docs
		.app(appId)
		.set({ run_lock: FieldValue.delete() }, { merge: true })
		.then(
			() => {},
			(err) => {
				log.error("[clearRunLock] Firestore write failed", err, { appId });
			},
		);
}

/**
 * Revert a bailed claim — write the {@link PriorRunState} snapshot back
 * VERBATIM, so a bailed-out claim (concurrency 429, out-of-credits, reservation
 * failure) returns the app to the EXACT shape `claimRun` found it in.
 *
 * A single merge-set restores EVERY field the claim overwrote:
 * `status` + `error_type` (a build flip reverts to `complete`/`error`+its
 * original classification; an edit claim reverts its `status → complete`
 * normalize), `awaiting_input` (DELETED — a claim only runs on a FREE app, which
 * is never paused, so the prior is always unpaused), `run_lock` (re-set a
 * hard-killed edit's exact stale lock the claim overwrote, else DELETED — a
 * build/fresh-edit claim found none), and `updated_at` (written back VERBATIM,
 * NOT a fresh server timestamp). Reverting `updated_at` verbatim is load-bearing:
 * a fresh stamp would re-arm the ~10-min `generating` staleness clock on a
 * reverted stale-build row (a phantom "in progress" for 10 min) and reorder a
 * plain `complete`/`error` app to the top of every member's recent list though
 * nothing ran. `FieldValue.delete()` for the absent-prior cases is what makes
 * the revert faithful rather than leaving a stale `false`/lock behind. The
 * reservation marker is intentionally not reverted (see {@link PriorRunState}).
 * Fire-and-forget like `failApp`: a rejection must not block on Firestore, and a
 * dropped revert degrades to the reaper settling the still-held row.
 */
export function restoreRunState(
	appId: string,
	prior: PriorRunState,
): Promise<void> {
	return docs
		.app(appId)
		.set(
			{
				status: prior.status,
				error_type: prior.error_type,
				awaiting_input: prior.awaiting_input ? true : FieldValue.delete(),
				run_lock: prior.run_lock ?? FieldValue.delete(),
				updated_at: prior.updated_at,
			},
			{ merge: true },
		)
		.then(
			() => {},
			(err) => {
				log.error("[restoreRunState] Firestore write failed", err, { appId });
			},
		);
}

/**
 * Clean EDIT completion — delete the `run_lock` AND settle the run's kept-charge
 * reservation marker in ONE transaction.
 *
 * The atomicity is the edit-mode analogue of {@link completeAndSettleRun}. An
 * edit stays `complete` throughout, so what makes it CLAIMABLE is the `run_lock`
 * being gone. Releasing the lock and settling the kept charge as two separate
 * writes opens the same clawback window: the instant the lock is deleted the app
 * is claimable, and a run landing before the settle would see the edit's
 * still-unsettled marker and (per the unconditional leftover-refund) claw back
 * its KEPT 5 credits. One transaction closes it — the moment the edit is
 * claimable, its charge is already settled.
 *
 * A hard kill BEFORE this transaction leaves the `run_lock` present → the app is
 * not yet claimable and `reapStaleReservation` refunds the stranded hold once
 * `expireAt` passes (correct — the edit never finished). AFTER → claimable +
 * settled + kept.
 *
 * Settles WHATEVER unsettled marker is on the app (the `askQuestions` flow is
 * multi-POST, so the kept charge may have been booked by an earlier POST). Runs
 * as a transaction (read marker → write) so the settle rides the same commit as
 * the lock delete. Awaited by the caller so the terminal state is durable.
 */
export async function clearRunLockAndSettle(
	appId: string,
	runId: string,
): Promise<void> {
	await withFirestoreRetry(() =>
		runThrottledTransaction(getDb(), async (tx) => {
			// RAW ref (converter-less) for the same reason as `completeAndSettleRun`:
			// only the run-liveness leaves are needed, and a converter parse of a bad
			// blueprint would throw inside the txn and strand the lock release + settle.
			const snap = await tx.get(docs.appRaw(appId));
			const fresh = (snap.exists ? snap.data() : undefined) as
				| Partial<AppDoc>
				| undefined;
			if (!fresh) return;
			const lease = runLeaseState(fresh);
			// OWNERSHIP GATE (re-checked at WRITE time, in the txn). Release the lock
			// + settle ONLY if this run still OWNS the edit lock. It no-ops on the
			// reaper-race that survives without a barge: this edit's lease lapsed
			// mid-run, it was REAPED (lock released + hold refunded), and the freed app
			// was re-claimed — so `run_lock.runId` changed (`mine` false) or the app is
			// no longer an edit (`mode !== "edit"`), and deleting the new run's LIVE
			// lock + settling its marker would double-run + claw its charge. The
			// `withFirestoreRetry` wrapper makes a clean completion land through a
			// transient blip, so a genuine owner reliably settles+releases (no 15-min
			// lockout from a dropped clean finalize).
			if (lease.mode !== "edit" || !lease.terminalWriteOwned(runId)) return;
			const reservation = fresh.reservation;
			tx.set(
				docs.appRaw(appId),
				{
					run_lock: FieldValue.delete(),
					...(reservation && !reservation.settled
						? { reservation: { ...reservation, settled: true } }
						: {}),
				},
				{ merge: true },
			);
		}),
	);
}

/**
 * Whether the app is STILL an EDIT run owned by `runId` — the guard the route's
 * `onFinish` net runs before releasing a prelude-throw-stranded lock.
 *
 * A run that DID finalize already made the right lock decision; this only fires
 * when `finalizeRun` never ran (a prelude throw), and must not release a lock a
 * DIFFERENT run now owns (this run's lease lapsed + it was reaped + the freed app
 * re-claimed). Ownership is derived through the one reader (`runLeaseState().mine`),
 * so it applies the same edit-ownership rule the resume path uses (a build has no
 * lock, so `mode !== "edit"` ⇒ `false`).
 *
 * Reads the RAW ref (converter-less — only run-liveness leaves are needed).
 * A thrown read bubbles; the caller decides best-effort semantics.
 */
export async function editRunLockHeldBy(
	appId: string,
	runId: string,
): Promise<boolean> {
	const snap = await docs.appRaw(appId).get();
	if (!snap.exists) return false;
	const lease = runLeaseState(snap.data() as Partial<AppDoc>);
	return lease.mode === "edit" && lease.mine(runId);
}

/**
 * Re-acquire a free-continuation resume's paused run — the supersede guard AND
 * lease re-establishment, in ONE atomic transaction, UNIFORM across both modes.
 *
 * A paused run holds its app (a paused run BLOCKS a claim — no takeover), but its
 * lease lapses while it waits for the user (no heartbeat during a pause), so it
 * CAN be REAPED mid-answer and the freed app re-claimed by another run. The resume
 * does NOT re-claim, so without this it could start a SECOND SA loop against an
 * app another run now owns. It also must RENEW its own liveness horizon: a paused
 * edit whose lease lapsed while the user answered would proceed on an
 * already-lapsed lease and be reaped mid-run — the horizon renewal makes "still
 * mine" and "not about to be reaped" the same atomic fact. `false` ⇒ superseded
 * (reaped + re-claimed) ⇒ bail, touched nothing.
 *
 * Ownership is `runLeaseState().ownedByResume(runId, mode)` — keyed on the
 * RESUME's OWN mode, so a run re-claimed in the OTHER mode still reads the right
 * discriminator: an edit-resume requires `mode === "edit" && mine` (a reap
 * cleared the lock or a re-claim overwrote its `runId`); a build-resume requires a
 * paused-build shape `mode === "build" && paused && mine`.
 *
 * RE-ESTABLISHES the mode's liveness horizon atomically when ownership holds, so
 * a resume RENEWS its lease rather than being reaped mid-run: an edit RE-STAMPS
 * `run_lock.expireAt`; a build RE-ARMS `updated_at` (its staleness clock froze
 * during the pause). Also clears `awaiting_input` in the SAME transaction (the
 * resume is no longer paused), so the assert + lease-renew + un-pause commit as
 * one atomic write and a lost resume touches nothing.
 *
 * Returns the resume's standing so the route can tell the user the TRUTH about
 * why a lost run was lost (the two causes read very differently to the person
 * answering):
 *  - `"owned"` — ownership held + lease renewed + pause cleared; proceed.
 *  - `"superseded"` — ANOTHER run occupies the app now (`lease.present`): this
 *    run was reaped and a co-member (or a fresh request) re-claimed the freed
 *    app. "Someone else started working on this app" is accurate.
 *  - `"released"` — NOTHING holds the app: the run's lease lapsed while the
 *    user answered and a scan reaped it (refund + free), with no re-claim
 *    since. On a personal Project this is the ONLY lost-resume shape — there
 *    is no one else — so a takeover message here would always be false.
 * Both lost shapes touched NOTHING (the caller bails). A thrown read bubbles;
 * the caller decides fail-open vs fail-closed.
 */
export type ReacquireOutcome = "owned" | "superseded" | "released";

export async function reacquireLease(
	appId: string,
	runId: string,
	mode: "build" | "edit",
): Promise<ReacquireOutcome> {
	return await runThrottledTransaction(getDb(), async (tx) => {
		const snap = await tx.get(docs.appRaw(appId));
		const fresh = (snap.exists ? snap.data() : undefined) as
			| Partial<AppDoc>
			| undefined;
		if (!fresh) return "released";
		const lease = runLeaseState(fresh);
		// Lost — this paused run's lease lapsed while the user answered and it was
		// REAPED. Keyed on the RESUME's OWN mode (`ownedByResume`), NOT `lease.mine`
		// off the doc's derived mode: a re-claim in the OTHER mode changes the derived
		// `mode`, so `mine` would read the wrong discriminator (the marker's runId for
		// a build vs the lock's for an edit). `ownedByResume` requires the app to
		// STILL be in the shape the resume expects — an edit's lock (a reap cleared
		// it / a re-claim overwrote it) or a paused-build shape (a reap flipped it /
		// a re-claim cleared `awaiting_input`). The lost shapes split on whether a
		// NEW run occupies the app (`present`: re-claimed → superseded) or the reap
		// simply freed it (released) — the route's message honesty rides on this.
		if (!lease.ownedByResume(runId, mode)) {
			return lease.present ? "superseded" : "released";
		}
		if (mode === "edit") {
			// Renew the edit lease (may have lapsed while paused) + un-pause, atomically.
			tx.update(docs.appRaw(appId), {
				"run_lock.expireAt": Timestamp.fromMillis(editLeaseDeadlineMs()),
				awaiting_input: false,
			});
		} else {
			// Re-arm the build's staleness window (frozen during the pause) + un-pause.
			tx.update(docs.appRaw(appId), {
				updated_at: FieldValue.serverTimestamp(),
				awaiting_input: false,
			});
		}
		return "owned";
	});
}

/**
 * Mark an app as failed after an error during generation.
 *
 * Fire-and-forget — a Firestore outage must never block the error response.
 * The timeout inference in `listApps()` serves as a backstop if this
 * write fails or the process dies before reaching this code.
 */
export function failApp(appId: string, errorType: ErrorType): void {
	docs
		.app(appId)
		.set(
			{
				status: "error",
				error_type: errorType,
			},
			{ merge: true },
		)
		.catch((err) => log.error("[failApp] Firestore write failed", err));
}

/**
 * Set or clear a build's `awaiting_input` pause flag.
 *
 * `true` when the SA pauses on an `askQuestions` round (so the staleness reaper
 * skips the live paused build); `false` when a POST resumes the run.
 *
 * Clearing ALSO re-arms `updated_at`. The flag — not a fresh timestamp — is what
 * spared the row from staleness during the pause, so removing it must hand the
 * resuming run a fresh staleness window. Otherwise the run is born STALE (its
 * `updated_at` is still the pre-pause value, already past the window) and a
 * concurrent `listApps` scan — whose reaper excludes no appId — could refund the
 * still-LIVE hold and flip the row to `error` before the resume's first mutation
 * advances the clock. A genuinely-dead resume still reaps, just one window later.
 * The SET path must NOT bump the clock (the flag, not the timestamp, protects a
 * pause; bumping there would only blur a real hard-kill's staleness).
 *
 * Returns the (self-catching) write promise. The route AWAITS the pause SET so
 * the flag is durably recorded before the response resolves — a container kill
 * after that point can't drop it and leave a live paused build reapable. The
 * resume CLEAR stays fire-and-forget (its rare write-failure degrades to the
 * already-accepted "abandoned paused build keeps its charge"). Either way the
 * write lands in milliseconds, far inside the 10-minute staleness window.
 */
export function setAwaitingInput(
	appId: string,
	awaiting: boolean,
): Promise<void> {
	return docs
		.app(appId)
		.set(
			awaiting
				? { awaiting_input: true }
				: { awaiting_input: false, updated_at: FieldValue.serverTimestamp() },
			{ merge: true },
		)
		.then(
			// Discard the WriteResult so the promise is `void`, and swallow errors
			// (observability must never block the response) — the same fire-and-forget
			// contract `failApp` has, just awaitable for the durable pause SET.
			() => {},
			(err) => {
				log.error("[setAwaitingInput] Firestore write failed", err);
			},
		);
}

/**
 * Reap a stale `generating` app: refund its stranded credit reservation, THEN
 * flip it to `error`.
 *
 * This is the dedicated reap path for a build the process never finished — a
 * hard kill (deploy SIGTERM, OOM, scale-in) before any in-process finalize ran,
 * which leaves the credit hold stranded because the live refund only runs from a
 * flush. Plain `failApp` writes status only; this also returns the credits.
 *
 * Delegates to `refundStaleGeneration`, which refunds the stranded hold AND flips
 * `generating → error` in ONE transaction with the staleness RE-VALIDATED inside
 * it. The in-txn re-check closes a TOCTOU: this reap is fired off an
 * out-of-transaction `listApps` / `hasActiveGeneration` scan, so between the scan
 * and the refund a FRESH build can re-claim the app (`claimRun('build')` re-arms
 * `updated_at` + writes a fresh marker) — refunding + failing that live build
 * would claw its charge and brick it. `refundStaleGeneration` re-reads in the txn
 * and acts ONLY if the row is STILL `reapableStaleBuild`; a re-claimed build reads
 * live and it no-ops. Doing the refund + the `error` flip in the same commit means
 * no fresh run can slip between them either. Idempotent (a second reap of an
 * `error` row is no longer `generating` → no-op).
 *
 * An app with no marker (created before reservations shipped, or whose run never
 * reserved) reaps to `error` with no refund. Fire-and-forget at the scan call
 * sites (`projectAppSummary` / `hasActiveGeneration`), like `failApp`, and
 * AWAITED from `claimRun`'s conflict path (the waiter-side nudge that frees an
 * abandoned paused build): a transient failure self-heals on the next scan/poll.
 *
 * Scope: BUILDS only. The reaper keys on `status: "generating"`, which only the
 * build paths write — `createApp` for a new build, `claimRun('build')` for every
 * chargeable build POST against an existing app. A chargeable EDIT reserves
 * credits but keeps its app `complete`, so its hard-killed hold is reaped off the
 * `run_lock`'s lapsed lease by the edit-only `reapStaleReservation` (called from
 * `projectAppSummary`) rather than here.
 */
export async function reapStaleGenerating(appId: string): Promise<void> {
	try {
		await refundStaleGeneration(appId);
	} catch (err) {
		log.error("[reapStaleGenerating] stale-build reap failed", err, { appId });
		// Leave the row `generating` (untouched) so the next scan retries — the
		// refund + flip are atomic, so a failure means neither happened.
	}
}

/**
 * Reap a stranded EDIT reservation: refund an unsettled hold whose run never
 * reached a clean completion, WITHOUT flipping status.
 *
 * The edit-only twin of `reapStaleGenerating`. An edit run stays `complete`
 * (its status never flips to `generating`), so a hard kill leaves its 5-credit
 * hold stranded on a row the `generating`-keyed reaper never scans. This reaper
 * keys on the SINGLE run-liveness signal — the `run_lock` (the one the
 * per-commit heartbeat refreshes): it fires only on a `status === "complete"`
 * app whose marker is present + unsettled and whose EDIT is a hard kill —
 * `run_lock` PRESENT but PAST its refreshed `expireAt`. A paused edit is NOT
 * excluded: the lapsed lease is the reap signal paused or not, which is how an
 * ABANDONED paused edit (the user never answered, the tab closed) frees instead
 * of holding the app forever; a recently-paused edit's lease is still future, so
 * it is untouched. A LIVE edit keeps a future `run_lock.expireAt` as long as
 * it commits, so even one running far past the initial `MAX_RUN_MINUTES` lease is
 * never reaped. Requiring the lock be PRESENT is what excludes a BUILD's marker:
 * a build never claims a `run_lock`, so a `complete` app with an unsettled marker
 * and NO lock is a build's KEPT charge (settled atomically by
 * `completeAndSettleRun`; a prelude-throw edit whose lock was cleared is refunded
 * by its own zero-cost `flush`), never a stranded edit — reaping it would claw back
 * a completed build's kept 100 credits. Builds reap off `updated_at` staleness
 * (`reapStaleGenerating`) while `generating`.
 *
 * The out-of-transaction read below is ONLY a pre-filter: the actual refund runs
 * through `refundStaleReservation`, which RE-VALIDATES the whole guard (status,
 * awaiting_input, unsettled, run_lock-present-and-lapsed) INSIDE its transaction.
 * That closes a TOCTOU: between this read (looks dead) and the refund, a fresh
 * edit can win the app and `reserveCredits` writes its own unsettled marker + a
 * fresh `run_lock` — the in-txn re-check sees the live lock and skips, so a live
 * charge is never clawed back.
 *
 * Called from `projectAppSummary` (fire-and-forget — the `listApps` scan sees
 * `complete` apps; NOT `hasActiveGeneration`, whose queries filter
 * `status === "generating"` and so never see an edit hold) and AWAITED from
 * `claimRun`'s conflict path (the waiter-side nudge that frees an abandoned
 * paused holder). A transient failure self-heals on the next scan/poll
 * (`refundStaleReservation`'s settle is idempotent, so a double-fire can't
 * double-refund).
 *
 * The every-kept-charge-settled invariant is the other half of the claw-back
 * protection: a clean, non-paused completion settles the kept charge ATOMICALLY
 * with the make-claimable transition (`clearRunLockAndSettle` for an edit,
 * `completeAndSettleRun` for a build) BEFORE the app is claimable/reapable, so a
 * completed edit's KEPT charge is already `settled: true` and this no-ops on it.
 */
export async function reapStaleReservation(appId: string): Promise<void> {
	// The WHOLE body swallows its own faults — `claimRun`'s conflict-path nudge
	// AWAITS this, and a transient Firestore fault escaping here would replace
	// the RunConflictError the caller must rethrow.
	try {
		// Cheap out-of-transaction pre-filter off the RAW ref (converter-less —
		// only the run-liveness leaves are needed, not the whole blueprint): skip
		// the transaction entirely unless the row LOOKS reapable. The full guard
		// is re-checked INSIDE `refundStaleReservation`'s transaction, so the
		// "never reap a live hold" invariant is self-contained in the refund path
		// (not dependent on this caller or `projectAppSummary`). This read only
		// avoids opening a transaction on the common not-reapable row.
		const data = (await docs.appRaw(appId).get()).data() as
			| Partial<AppDoc>
			| undefined;
		// Reap ONLY a hard-killed EDIT — `runLeaseState().reapableStrandedEdit` is
		// the single shared derivation (complete + unsettled marker + a `run_lock`
		// present-and-lapsed), so this pre-filter, `projectAppSummary`, and
		// `refundStaleReservation`'s in-txn re-check can't drift.
		if (!data || !runLeaseState(data).reapableStrandedEdit) return;
		await refundStaleReservation(appId);
	} catch (err) {
		log.error("[reapStaleReservation] reservation refund failed", err, {
			appId,
		});
	}
}

/**
 * Soft-delete an app by recording the moment of deletion and the
 * recoverable-until deadline.
 *
 * **Status is intentionally untouched.** `deleted_at` (presence of a
 * non-null timestamp) is the sole soft-delete marker — lifecycle
 * status and existence live on independent axes, so a deleted `error`
 * app stays an `error` app, a deleted `complete` app stays `complete`,
 * and `restoreApp` can clear the marker without making any policy
 * decision about lifecycle. This matches the standard soft-delete
 * pattern and removes the round-trip-loss problem the old status-flip
 * approach had.
 *
 * The row is NOT removed from Firestore — `listApps` binds
 * `where("deleted_at", "==", null)` so deleted rows never enter the
 * active list, but the blueprint, event log, and HQ credentials
 * survive intact so a restore within the recovery window is a pair-
 * of-fields nullify and nothing more. The 30-day window mirrors the
 * chat-side support window for accidental-delete recovery.
 *
 * Returns the ISO-8601 `recoverable_until` timestamp so callers can
 * surface the deadline to users. Uses Firestore's `update()` so a
 * missing document rejects with a `NOT_FOUND` error rather than
 * materializing a partial ghost row — a merge-create on a non-existent
 * id would land a row that fails the full `appDocSchema` parse (no
 * owner, no blueprint) and quietly poison later reads. Callers decide
 * how to map the thrown rejection to their error surface.
 */
export async function softDeleteApp(appId: string): Promise<string> {
	/* 30 days — matches the chat-side support window for accidental-delete
	 * recovery. Expressed in ms so arithmetic + `new Date(...)` stay in
	 * one unit. */
	const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
	const now = new Date();
	const deletedAt = now.toISOString();
	const recoverableUntil = new Date(now.getTime() + RETENTION_MS).toISOString();
	await docs.app(appId).update({
		deleted_at: deletedAt,
		recoverable_until: recoverableUntil,
	});
	return recoverableUntil;
}

/**
 * Restore a soft-deleted app — the inverse of `softDeleteApp`.
 *
 * Clears `deleted_at` and `recoverable_until` as a pair (the invariant
 * `softDeleteApp` sets them as a pair, this clears them as a pair).
 * Status is intentionally untouched: a deleted `error` app stays an
 * `error` app after restore, a deleted `complete` app stays `complete`.
 * Soft-delete is the existence axis; lifecycle status is its own.
 *
 * Uses `.update()` for the same NOT_FOUND-on-missing-row reason the
 * soft-delete helper does — a `set()` would materialize a ghost row
 * lacking `owner` / `blueprint`. Callers decide how to map the thrown
 * rejection to their error surface.
 *
 * `updated_at` is intentionally not bumped: the blueprint hasn't
 * changed, and the stale-`generating` reaper inside `listApps` is
 * keyed on `generating` rows only, so a stale timestamp on a restored
 * `"complete"`/`"error"` row is harmless.
 */
export async function restoreApp(appId: string): Promise<void> {
	await docs.app(appId).update({
		deleted_at: null,
		recoverable_until: null,
	});
}

/**
 * Load a single app document by ID.
 *
 * Returns the full AppDoc (including blueprint) or null if not found.
 * The Zod converter validates the document on read. Callers that serve
 * user-facing data must verify `app.owner === session.user.id` for
 * authorization — the root-level collection doesn't scope by user.
 */
export async function loadApp(appId: string): Promise<AppDoc | null> {
	const snap = await docs.app(appId).get();
	return snap.exists ? (snap.data() ?? null) : null;
}

/**
 * Resolve the display name of whoever currently HOLDS the app's run window, for
 * the serialize-with-wait "busy: <name>'s request" status the waiter emits.
 *
 * The holder is whichever run owns the app right now: an edit lock records its
 * actor on `run_lock.actorUserId`; a build hold records its charged actor on the
 * reservation marker (`reservation.userId`, falling back to `owner` for a legacy
 * marker or the pre-reservation new-build window). The `run_lock` actor wins
 * when both are present — a live edit-lock is the current holder. Reads the
 * name from `auth_user` (Kysely), the same denormalized profile presence shows.
 *
 * Uses a PROJECTED read of only the three holder-id fields (`documentId()` +
 * `.select()`), never the full `loadApp` — this is on the serialize-with-wait
 * path, and pulling the whole (multi-hundred-KB) blueprint just to render a
 * display name would be wasteful.
 *
 * Best-effort: returns `"someone"` when the app or holder can't be resolved (a
 * generic fallback keeps the busy status friendly without leaking a raw id) —
 * the wait itself keys on `claimRun`, never on this label.
 */
export async function loadAppHolderName(appId: string): Promise<string> {
	const snap = await getDb()
		.collection("apps")
		.where(FieldPath.documentId(), "==", appId)
		.select("run_lock.actorUserId", "reservation.userId", "owner")
		.limit(1)
		.get();
	const doc = snap.docs[0];
	if (!doc) return "someone";
	const holderId =
		(doc.get("run_lock.actorUserId") as string | undefined) ??
		(doc.get("reservation.userId") as string | undefined) ??
		(doc.get("owner") as string | undefined);
	if (!holderId) return "someone";
	try {
		const db = await getAuthDb();
		const row = await db
			.selectFrom("auth_user")
			.select(["name"])
			.where("id", "=", holderId)
			.executeTakeFirst();
		return row?.name || "someone";
	} catch (err) {
		log.error("[loadAppHolderName] auth_user lookup failed", err, { appId });
		return "someone";
	}
}

/**
 * Load just the owning Project id for an app document.
 *
 * The lightweight projected read the authorization resolver uses: reads only
 * `project_id` via a `documentId()` + `.select()` query, avoiding the full
 * blueprint load + Zod validation. Returns null when the row is absent or the
 * field is unset (a pre-backfill row).
 */
export async function loadAppProjectId(appId: string): Promise<string | null> {
	/* Projected read — `DocumentReference.get()` has no field mask, so this uses a
	 * `documentId()` query with `.select()` to transfer ONLY `project_id` rather
	 * than pulling the full (multi-hundred-KB) blueprint over the wire on every
	 * authorization gate. */
	const snap = await getDb()
		.collection("apps")
		.where(FieldPath.documentId(), "==", appId)
		.select("project_id")
		.limit(1)
		.get();
	const doc = snap.docs[0];
	if (!doc) return null;
	return (doc.get("project_id") as string | undefined) ?? null;
}

/**
 * Denormalized fields fetched by `listApps`.
 *
 * Excludes `app_name_lower` — it is a sort key on the index side but
 * never needs to be returned. `AppSummary` carries the display-cased
 * `app_name`, and `searchApps`'s Fuse instance normalizes case per
 * match. Firestore's `orderBy` on `app_name_lower` works whether the
 * field is in the `select()` projection or not.
 *
 * Soft-delete is filtered at the Firestore query layer via
 * `where("deleted_at", "==", null)` — it does not need to ride the
 * projection.
 */
const SUMMARY_FIELDS = [
	"app_name",
	"connect_type",
	"module_count",
	"form_count",
	"status",
	// Projected so `projectAppSummary`'s staleness reaper can exclude a live build
	// paused on an `askQuestions` round (it must not refund a paused hold).
	"awaiting_input",
	// Projected so `projectAppSummary` can fire the edit-only
	// `reapStaleReservation` for a `complete` app whose unsettled hold is past
	// its `expireAt` — the stranded-edit-hold reaper the `generating`-keyed scan
	// can't reach.
	"reservation",
	// Projected so `projectAppSummary` sees a live edit-lock (it doesn't reap off
	// it, but the field rides the projection alongside `reservation` for parity
	// with the run-liveness fields a scan reasons about).
	"run_lock",
	"error_type",
	// The logo lives inside the blueprint; a dotted field path reads JUST that
	// leaf (not the large blueprint map), so the app list shows it for every
	// app — including ones saved before any denormalized copy existed.
	"blueprint.logo",
	"created_at",
	"updated_at",
] as const;

/**
 * How many extra rows `searchApps` fetches beyond its caller-requested
 * `limit`, to give Fuse enough candidates to score meaningfully.
 *
 * With the buffer, a user with a few hundred apps can get a full page
 * of matches in one round trip. If the buffer exhausts without
 * producing enough matches, `searchApps` falls back to returning
 * whatever matched and emits the Firestore cursor so the caller can
 * continue scanning the next batch.
 */
const SEARCH_FETCH_BUFFER = 90;

/**
 * Fuse.js threshold — how fuzzy is a match? 0 is exact; 1 matches
 * anything. 0.4 strikes a balance that catches most typos + prefix
 * matches + substring matches without turning up garbage on short
 * queries. Tuned for app-name-length strings.
 */
const FUSE_THRESHOLD = 0.4;

/**
 * Encode a structured cursor as an opaque URL-safe string.
 *
 * The outer world only ever sees the base64url form — the JSON shape
 * (including the discriminant and the sort-key value) is an
 * implementation detail. If the shape needs to change later, bump a
 * version field inside the JSON and let the decoder reject old forms.
 */
function encodeAppsCursor(cursor: ListAppsCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor back into its structured form, validating
 * the `kind` discriminant. Throws on malformed input or an unknown
 * kind so callers surface the error to their client instead of
 * silently resuming from the wrong index position.
 */
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
	/* Re-cast through `unknown` so the subsequent property reads don't
	 * assume a shape — each field is explicitly runtime-checked. */
	const obj = parsed as Record<string, unknown>;
	const kind = obj.kind;
	const id = obj.id;
	if (typeof id !== "string") {
		throw new Error("Invalid pagination cursor (missing id).");
	}
	/* Two sort axes share the same cursor payload shape — only the
	 * discriminant `kind` differs — so validate per-axis rather than
	 * per-direction. That keeps the branch count from doubling as new
	 * directions land on existing axes. */
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

/**
 * Build a cursor that resumes scanning AFTER the given summary.
 *
 * The `sort` argument picks which sort key goes into the cursor — a
 * cursor minted for one sort cannot be consumed by a subsequent call
 * with a different sort (enforced at decode time inside `listApps`).
 * The cursor's `kind` is the sort's own string so the discriminant
 * stays in lockstep with `AppsSortOrder`.
 *
 * For the name-sort branches we recompute `.toLowerCase()` from
 * `app_name`; this matches what `denormalize` writes to Firestore
 * byte-for-byte (both are JS `.toLowerCase()` on the same string), so
 * the cursor value lines up exactly with the indexed field.
 */
function cursorFor(summary: AppSummary, sort: AppsSortOrder): string {
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
				name_lower: summary.app_name.toLowerCase(),
				id: summary.id,
			});
	}
}

/**
 * Project a Firestore document snapshot into the `AppSummary` shape
 * returned by `listApps`, applying the stale-`generating` reaper on
 * the way out.
 *
 * Soft-delete filtering is handled at the query layer (`where(
 * "deleted_at", "==", null)`), so every row that reaches this
 * function is already known to be live. Consolidated here so
 * `listApps` has one projection site; any schema drift between
 * Firestore and `AppSummary` fails in one place.
 */
function projectAppSummary(
	doc: FirebaseFirestore.QueryDocumentSnapshot,
	now: number,
): AppSummary {
	const data = doc.data();

	const createdAt = (data.created_at as Timestamp).toDate();
	const updatedAt = (data.updated_at as Timestamp)?.toDate() ?? createdAt;

	/* Run-liveness for BOTH reapers is derived through the one reader.
	 * `reapableStaleBuild` is a `generating` build whose `updated_at` fell outside
	 * the staleness window — a HARD KILL or an ABANDONED PAUSED build (a paused
	 * run's clock freezes, so it drifts past the window; its own resume re-arms
	 * `updated_at`, so a legit recently-paused build stays fresh). Intermediate
	 * saves advance `updated_at`, so an actively-running build always reads fresh.
	 * The reap (refund the stranded credit hold + flip to error) is fire-and-forget;
	 * the projected row below reflects the inferred `error` immediately so the caller
	 * never sees stale data even though the reap transaction settles asynchronously. */
	const lease = runLeaseState(data as Partial<AppDoc>, now);
	const isStale = lease.reapableStaleBuild;
	if (isStale) {
		void reapStaleGenerating(doc.id);
	}

	/* Edit-only stranded-hold reap — an edit stays `complete`, so its
	 * hard-killed 5-credit hold never enters the build staleness inference above.
	 * `reapableStrandedEdit` is the single shared derivation (complete +
	 * unsettled marker + a `run_lock` present-and-lapsed):
	 * keying on the `run_lock`'s liveness horizon stops clawing back a LIVE long
	 * edit that refreshed its lease, and requiring the lock be PRESENT excludes a
	 * completed BUILD's kept-charge marker (a build has no `run_lock`). The reap
	 * refunds only; it never flips status, so the projected row is unchanged.
	 * `refundStaleReservation` re-validates the SAME derivation in-transaction, so a
	 * fresh edit that won the app between the scan and the refund isn't clawed back. */
	if (lease.reapableStrandedEdit) {
		void reapStaleReservation(doc.id);
	}

	return {
		id: doc.id,
		app_name: data.app_name as string,
		connect_type: (data.connect_type as AppDoc["connect_type"]) ?? null,
		module_count: (data.module_count as number) ?? 0,
		form_count: (data.form_count as number) ?? 0,
		status: isStale ? "error" : (data.status as AppDoc["status"]),
		error_type: isStale
			? "internal"
			: ((data.error_type as string | null) ?? null),
		logo: (data.blueprint as { logo?: string } | undefined)?.logo ?? null,
		created_at: createdAt.toISOString(),
		updated_at: updatedAt.toISOString(),
	};
}

/**
 * Paginate a user's apps sorted by last modified or by name.
 *
 * Queries the root-level `apps` collection filtered by `owner`. Uses
 * Firestore `select()` to fetch only the denormalized summary fields —
 * the blueprint (the large nested object) is never read. Validation is
 * unnecessary here because data is validated on write (`commitGuardedBatch`,
 * the one validating writer) and defaults are baked in at that time.
 *
 * Soft-deleted rows are filtered at the Firestore query layer via
 * `where("deleted_at", "==", null)`. Filtering in JS after `.limit(N)`
 * is the obvious-looking alternative but lets a deleted-heavy page
 * return short with `next_cursor` still set. Server-side filtering
 * preserves "page returns up to `limit` visible rows; cursor set iff
 * more truly exist."
 *
 * A secondary `orderBy("__name__", "asc")` is appended to every query —
 * it is Firestore's document id, implicitly the tiebreaker — so a
 * cursor built from `(sort_field, id)` resumes deterministically even
 * when two apps share the same sort-field value (common for
 * `updated_at` when writes land in the same tick).
 *
 * Required composite indexes (all scoped to `collectionGroup: "apps"`,
 * `deleted_at` first so the equality filter binds the prefix):
 *   - `(owner ASC, deleted_at ASC, updated_at DESC)` — default sort.
 *   - `(owner ASC, deleted_at ASC, updated_at ASC)` — updated_asc.
 *   - `(owner ASC, deleted_at ASC, app_name_lower ASC)` — name_asc.
 *   - `(owner ASC, deleted_at ASC, app_name_lower DESC)` — name_desc.
 *   - The same four with `status ASC` inserted before the sort field
 *     for status-filtered variants.
 *
 * Pagination semantics: `nextCursor` is present iff Firestore returned
 * exactly `limit` rows. Because the soft-delete filter runs server-
 * side, every returned doc is visible — `apps.length === snap.size` —
 * so the cursor accurately signals "more visible apps may exist."
 *
 * Stale-generating reaper behavior is per-page: only rows scanned by
 * this call get reaped. An app that is stale but lives on a page the
 * caller never fetches stays stale until someone paginates that far.
 * Acceptable for the current scale (callers that walk the whole list —
 * the web UI's fixed 50-row page — always reach every row a typical
 * user has).
 */
async function queryAppsByScope(
	scopeField: "owner" | "project_id",
	scopeValue: string | readonly string[],
	options: ListAppsOptions,
): Promise<ListAppsResult> {
	const { limit, sort, status, cursor } = options;

	/* Use the untyped collection — `select()` returns partial documents that
	 * would fail the Zod converter's full-schema validation (missing owner,
	 * blueprint). Raw DocumentData is fine; `projectAppSummary` casts fields
	 * on the way out. */
	let query: FirebaseFirestore.Query = getDb()
		.collection("apps")
		/* A single scope value is an equality match; a list (the multi-Project
		 * MCP enumeration) is an `in` disjunction. Firestore serves both off the
		 * same `(scope, deleted_at, sort_field, __name__)` composite index and
		 * applies the global orderBy + limit + startAfter cursor across the merged
		 * result, so the pagination contract is identical either way. */
		.where(scopeField, Array.isArray(scopeValue) ? "in" : "==", scopeValue)
		/* `createApp` writes `deleted_at: null` on every new doc, so this
		 * equality filter matches every live app — no missing-field rows
		 * to leak. See the function docblock for the rationale. */
		.where("deleted_at", "==", null);

	/* Status filter is a Firestore `where` clause, not an in-memory post-
	 * filter. The composite indexes cover `(owner, deleted_at, status,
	 * sort_field)` so filtered queries cost the same as unfiltered ones. */
	if (status) {
		query = query.where("status", "==", status);
	}

	query = query.select(...SUMMARY_FIELDS);

	/* The primary sort matches the caller's `sort` argument; `__name__`
	 * is the secondary so cursor resumption is deterministic (two apps
	 * that share a sort-field value still resolve to a unique ordering).
	 * Every branch uses `__name__ ASC` as the tiebreaker regardless of
	 * the primary direction — a single, consistent rule across every
	 * sort so reasoning about ordering never branches on the primary
	 * axis. The `firestore.indexes.json` composites follow the same
	 * convention. */
	switch (sort) {
		case "updated_desc":
			query = query.orderBy("updated_at", "desc").orderBy("__name__", "asc");
			break;
		case "updated_asc":
			query = query.orderBy("updated_at", "asc").orderBy("__name__", "asc");
			break;
		case "name_asc":
			query = query.orderBy("app_name_lower", "asc").orderBy("__name__", "asc");
			break;
		case "name_desc":
			query = query
				.orderBy("app_name_lower", "desc")
				.orderBy("__name__", "asc");
			break;
	}

	/* Cursor resumption: the cursor's `kind` must match the current `sort`.
	 * A mismatch means a client mixed sort orders across pagination calls
	 * and we cannot faithfully continue — throw so the error is visible
	 * rather than silently skipping or misordering rows. Dispatch on the
	 * sort *axis* (updated vs name) rather than direction — `startAfter`
	 * takes the raw value and Firestore's orderBy direction handles which
	 * side of that value comes next. */
	if (cursor) {
		const decoded = decodeAppsCursor(cursor);
		if (decoded.kind !== sort) {
			throw new Error(
				`Cursor was minted for sort="${decoded.kind}" but this call uses sort="${sort}".`,
			);
		}
		if (decoded.kind === "updated_desc" || decoded.kind === "updated_asc") {
			query = query.startAfter(
				Timestamp.fromDate(new Date(decoded.updated_at)),
				decoded.id,
			);
		} else {
			query = query.startAfter(decoded.name_lower, decoded.id);
		}
	}

	const snap = await query.limit(limit).get();

	const now = Date.now();

	/* Soft-deletes are filtered server-side — the loop is a straight
	 * 1:1 map, no per-row skip needed. */
	const apps: AppSummary[] = snap.docs.map((doc) =>
		projectAppSummary(doc as FirebaseFirestore.QueryDocumentSnapshot, now),
	);

	/* "Maybe more" signal: a full page may have followers; a short page
	 * never does. */
	const nextCursor =
		snap.size === limit ? cursorFor(apps[apps.length - 1], sort) : undefined;

	return { apps, nextCursor };
}

/**
 * List a Project's live apps — the tenancy listing (home page, /api/apps, MCP).
 * Thin wrapper over `queryAppsByScope`.
 */
export function listApps(
	projectId: string,
	options: ListAppsOptions,
): Promise<ListAppsResult> {
	return queryAppsByScope("project_id", projectId, options);
}

/**
 * List a user's OWN (created) apps by the `owner` field — for admin inspection
 * and the owner-keyed media-deletion reference scan, which are creator-scoped,
 * NOT tenancy-scoped. (The `owner`-leading composite indexes serve this.)
 */
export function listAppsByOwner(
	owner: string,
	options: ListAppsOptions,
): Promise<ListAppsResult> {
	return queryAppsByScope("owner", owner, options);
}

/**
 * List apps across SEVERAL Projects in one scan — the headless MCP enumeration
 * scope, where `projectIds` is every Project the caller is a member of (the same
 * reachability {@link resolveAppScope} grants app-by-app, so nothing the user
 * can open by id is invisible to enumeration). An empty list returns an empty
 * page without a query.
 *
 * Runs ONE `in`-scoped `queryAppsByScope`, so the sort, limit, and cursor
 * contract are identical to the single-Project `listApps`. Firestore caps the
 * `in` disjunction at 30 values; callers pass at most that many (see the MCP
 * tools), a bound that does not bite for Nova's small-team Project sizes.
 */
export function listAppsAcrossProjects(
	projectIds: readonly string[],
	options: ListAppsOptions,
): Promise<ListAppsResult> {
	if (projectIds.length === 0) return Promise.resolve({ apps: [] });
	return queryAppsByScope("project_id", projectIds, options);
}

/**
 * Search a single Project's apps by name with fuzzy matching — the tenancy
 * search (web UI). Composes over `listApps` through the shared
 * {@link rankSearchOverPage} core, which owns the over-fetch buffer, Fuse
 * relevance ranking, and cursor passthrough.
 */
export function searchApps(
	projectId: string,
	options: SearchAppsOptions,
): Promise<SearchAppsResult> {
	return rankSearchOverPage((scan) => listApps(projectId, scan), options);
}

/**
 * Fuzzy-search across EVERY Project the caller is a member of — the headless MCP
 * search scope, the search twin of {@link listAppsAcrossProjects}. Same
 * reachability set as `get_app` / the editing tools, so a remembered-by-name app
 * in a shared Project is findable here. Shares the Fuse ranking + cursor-
 * passthrough with `searchApps`; only the underlying scan differs.
 */
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
 * The shared search core: over-fetch one scan page, rank it with Fuse, take the
 * caller's `limit`, and pass the scan's cursor through. `scanPage` abstracts
 * which list scan backs the search (single Project or the cross-Project `in`
 * scan) so `searchApps` and `searchAppsAcrossProjects` differ only in that
 * backing call — the relevance ordering, over-fetch buffer, and cursor semantics
 * are defined once here.
 *
 * Composing over a list scan (rather than a bespoke query) means the scan owns
 * soft-delete stripping, stale-`generating` reaping, index usage, and partial-
 * field projection — mirroring any of that here would be a drift risk. Fuse runs
 * in memory and ranks by relevance (Bitap edit-distance scoring), which is why
 * the search surfaces expose no `sort`: relevance IS the ordering.
 *
 * Pagination: ONE scan per call (no internal looping), over-fetching by
 * `SEARCH_FETCH_BUFFER` so a typical query fills a page in one round trip. When
 * Fuse returns fewer than `limit` matches and the scan still has more rows, the
 * scan's `nextCursor` passes through and the caller re-calls to search the next
 * batch. The scan sorts `updated_desc` — searching newest-first gives the best
 * average-case latency for the dominant "find my recent X" intent; an old app is
 * still reachable across more pages because the cursor works.
 *
 * When per-Project app counts grow beyond the buffer's reach, this is the single
 * site to swap the in-memory Fuse filter for a search index (Algolia / Typesense
 * / trigram-denormalized storage); the tool schema + cursor contract stay put.
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
		/* Fuse configured for anywhere-in-string fuzzy substring matching.
		 * `ignoreLocation` disables the default preference for matches near
		 * the start of the string — users search for "vaccine" expecting to
		 * find "COVID Vaccine Tracker". `includeScore` is on so we could
		 * threshold further if needed; `threshold` already does most of that
		 * work up front. */
		const fuse = new Fuse(page.apps, {
			keys: ["app_name"],
			threshold: FUSE_THRESHOLD,
			ignoreLocation: true,
			includeScore: true,
		});

		/* Fuse returns results sorted best-first by its relevance score.
		 * Take the first `limit` — extras (beyond `limit`) are effectively
		 * discarded for this call; the caller can follow the cursor to get
		 * more matches from the next scan page. */
		const matches = fuse
			.search(query)
			.slice(0, limit)
			.map((result) => result.item);

		/* Cursor pass-through. A search call's "more available" signal is
		 * identical to the underlying scan page's — if Firestore had more to
		 * enumerate, there may be more matches to find; if not, the user has no
		 * more apps to search. Passing the cursor through preserves that 1:1
		 * semantic. */
		return { apps: matches, nextCursor: page.nextCursor };
	});
}

// ── Trash query ────────────────────────────────────────────────────

/**
 * Denormalized fields fetched by `listDeletedApps`. Adds the two
 * soft-delete timestamps to the standard summary projection so the
 * trash UI can render "deleted X ago" and "permanently deletes on
 * DATE" without a second read.
 *
 * Both must be listed explicitly: `SUMMARY_FIELDS` omits `deleted_at`
 * (the active `listApps` only *filters* on it via `where("deleted_at",
 * "==", null)`, and a `where` clause never widens the `.select()`
 * projection), so without it here `data.deleted_at` comes back
 * `undefined` and the "Deleted …" line renders "Invalid Date".
 */
const DELETED_SUMMARY_FIELDS = [
	...SUMMARY_FIELDS,
	"deleted_at",
	"recoverable_until",
] as const;

/** Options consumed by `listDeletedApps`. */
export interface ListDeletedAppsOptions {
	/**
	 * Max rows to return. Soft-deleted apps are bounded by the 30-day
	 * retention window, so a single `limit`-bounded page typically fits
	 * a typical user's whole trash — no cursor is exposed yet.
	 */
	limit: number;
}

/** Shape returned by `listDeletedApps`. */
export interface ListDeletedAppsResult {
	apps: DeletedAppSummary[];
}

/**
 * List a user's soft-deleted apps that are still within the recovery
 * window, most-recently-deleted first.
 *
 * Two filters in sequence:
 *
 *   1. **Firestore-level "is deleted":** `where("deleted_at", "!=",
 *      null)` excludes live rows at the query boundary. The orderBy-
 *      as-implicit-filter trick doesn't apply here: every live row
 *      writes `deleted_at: null` explicitly (see `createApp`), so the
 *      field is present in the index and `orderBy("deleted_at")` would
 *      return live rows too — consuming the page budget on rows that
 *      get stripped in JS.
 *   2. **In-memory "still recoverable":** rows whose `recoverable_until`
 *      has elapsed are filtered out before returning. The trash UI is
 *      a recovery surface, not a permanent archive — past-window
 *      tombstones don't belong there.
 *
 * The `__name__ ASC` tiebreaker resolves two apps deleted in the same
 * millisecond deterministically.
 *
 * Past-window rows persist on disk; this helper filters them out of
 * the trash UI once `recoverable_until` elapses.
 *
 * Status, error_type, and the standard timestamps are surfaced as-is.
 * Soft-delete is the existence axis, not the lifecycle axis — a
 * deleted `error` app keeps its `error` status (and `error_type`) so
 * the trash badge reads the truth. The stale-`generating` reaper from
 * `projectAppSummary` is irrelevant here: a deleted row's `updated_at`
 * is frozen by definition.
 *
 * Required composite index (in addition to those `listApps` uses):
 *   - `(owner ASC, deleted_at DESC, __name__ ASC)`.
 * See `firestore.indexes.json`.
 */
export async function listDeletedApps(
	projectId: string,
	options: ListDeletedAppsOptions,
): Promise<ListDeletedAppsResult> {
	/* Untyped collection ref for the same reason `listApps` uses one —
	 * `select()` returns partial documents that would fail the Zod
	 * converter's full-schema validation. */
	const snap = await getDb()
		.collection("apps")
		.where("project_id", "==", projectId)
		.where("deleted_at", "!=", null)
		.orderBy("deleted_at", "desc")
		.orderBy("__name__", "asc")
		.select(...DELETED_SUMMARY_FIELDS)
		.limit(options.limit)
		.get();

	const now = Date.now();

	const apps: DeletedAppSummary[] = [];
	for (const doc of snap.docs) {
		const data = doc.data();
		const recoverableUntil = data.recoverable_until as string;
		/* Past-window rows are excluded from the trash surface once
		 * `recoverable_until` elapses — the trash is a recovery
		 * surface, not a permanent archive. */
		if (new Date(recoverableUntil).getTime() <= now) continue;

		const createdAt = (data.created_at as Timestamp).toDate();
		const updatedAt = (data.updated_at as Timestamp)?.toDate() ?? createdAt;
		apps.push({
			id: doc.id,
			app_name: data.app_name as string,
			connect_type: (data.connect_type as AppDoc["connect_type"]) ?? null,
			module_count: (data.module_count as number) ?? 0,
			form_count: (data.form_count as number) ?? 0,
			/* Status pass-through. New-flow rows carry their real lifecycle
			 * state (`complete` / `error` / `generating`); legacy rows
			 * (deleted by the old status-flip code) carry the literal
			 * `"deleted"` until that data is scrubbed. The DeletedAppSummary
			 * type admits both. */
			status: data.status as AppDoc["status"],
			error_type: (data.error_type as string | null) ?? null,
			logo: (data.blueprint as { logo?: string } | undefined)?.logo ?? null,
			created_at: createdAt.toISOString(),
			updated_at: updatedAt.toISOString(),
			/* Both soft-delete fields are non-null on any row this query
			 * returns — the `orderBy("deleted_at")` filter implicitly drops
			 * nulls, and `softDeleteApp` writes the two fields as a pair.
			 * The cast is safe; a defensive null-guard would mask a write-
			 * side regression. */
			deleted_at: data.deleted_at as string,
			recoverable_until: recoverableUntil,
		});
	}

	return { apps };
}
