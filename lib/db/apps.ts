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
import { FieldValue, Timestamp } from "@google-cloud/firestore";
import Fuse from "fuse.js";
import type { ErrorType } from "@/lib/agent";
import { log } from "@/lib/logger";
import { toPersistableDoc } from "../doc/fieldParent";
import type { BlueprintDoc, PersistableDoc } from "../domain/blueprint";
import { collections, docs, getDb } from "./firestore";
import type { AppDoc } from "./types";

// ── Types ──────────────────────────────────────────────────────────

/** Subset of AppDoc fields returned by list queries (no full blueprint). */
export interface AppSummary {
	id: string;
	app_name: string;
	connect_type: AppDoc["connect_type"];
	module_count: number;
	form_count: number;
	status: AppDoc["status"];
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
 * Maximum age (in minutes) since the last Firestore write before a
 * 'generating' app is considered dead.
 *
 * Intermediate saves advance `updated_at` during generation, so an
 * actively-running build always has a recent timestamp. If `updated_at`
 * hasn't advanced in this window, the process was killed by the platform
 * or crashed without writing a failure status.
 */
const MAX_GENERATION_MINUTES = 10;

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

// ── Concurrency Guard ─────────────────────────────────────────────

/**
 * Check whether the user has an active generation in progress.
 *
 * Queries for any app owned by `owner` with `status: 'generating'` whose
 * last Firestore write was within the staleness window. Returns `true` if
 * an active generation exists that isn't the given `excludeAppId` — so
 * retries on the same build are allowed, but concurrent new builds are blocked.
 *
 * Soft-deleted rows are excluded server-side via `deleted_at == null`:
 * a deleted-mid-generation row is effectively abandoned and must not
 * keep blocking new builds.
 *
 * Single Firestore query with `limit(5)` — enough to find a live one
 * even if the first few results are stale or the excluded app.
 */
export async function hasActiveGeneration(
	owner: string,
	excludeAppId?: string,
): Promise<boolean> {
	const snap = await collections
		.apps()
		.where("owner", "==", owner)
		.where("deleted_at", "==", null)
		.where("status", "==", "generating")
		.limit(5)
		.get();

	if (snap.empty) return false;

	const now = Date.now();
	const maxAgeMs = MAX_GENERATION_MINUTES * 60_000;

	for (const doc of snap.docs) {
		if (doc.id === excludeAppId) continue;
		const updatedAt = (doc.data().updated_at as Timestamp)?.toDate();
		if (!updatedAt) {
			/* No updated_at means a corrupt or very old doc — definitively dead. */
			failApp(doc.id, "internal");
			continue;
		}

		/* Still within the generation window — a live build is in progress. */
		if (now - updatedAt.getTime() <= maxAgeMs) return true;

		/* Stale — infer failure so it won't block future checks. */
		failApp(doc.id, "internal");
	}

	return false;
}

// ── Existence Check ───────────────────────────────────────────────

/**
 * Lightweight existence check — does the user own at least one live
 * (non-soft-deleted) app?
 *
 * Uses `limit(1)` with no field projection so it's as cheap as a
 * Firestore read can be. Called by the root page before the Suspense
 * boundary to choose between the get-started state and the app list.
 *
 * The soft-delete filter mirrors `listApps`: a user who deleted every
 * app should land on get-started, not an empty list page.
 */
export async function userHasApps(owner: string): Promise<boolean> {
	const snap = await getDb()
		.collection("apps")
		.where("owner", "==", owner)
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
	 * Initial lifecycle status. Limited to the two valid creation states:
	 * `"generating"` arms the staleness timer in `listApps` (advanced on
	 * every write; a 10-minute gap self-marks the app as `error`);
	 * `"complete"` opts out for atomic creations with no follow-up writes.
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
	await ref.set({
		owner,
		...denormalize(emptyDoc),
		blueprint: persistable,
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
	});
	return ref.id;
}

/**
 * Update an app with the final validated doc on generation success.
 *
 * Called by validateApp after the build pipeline completes. Updates the
 * blueprint, denormalized fields, status, and run_id — preserves
 * created_at and owner.
 */
export async function completeApp(
	appId: string,
	doc: PersistableDoc,
	runId: string,
): Promise<void> {
	await docs.app(appId).set(
		{
			...denormalize(doc),
			blueprint: doc,
			status: "complete",
			run_id: runId,
			updated_at: FieldValue.serverTimestamp(),
		},
		{ merge: true },
	);
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
 * Merge-update an existing app with a new normalized doc snapshot.
 *
 * Called by both the client-side auto-save route (`PUT /api/apps/{id}`)
 * after user edits and by `GenerationContext.saveBlueprint` for
 * intermediate saves during generation. Accepts `PersistableDoc` (the
 * Zod-validated on-disk shape without `fieldParent`) so the route can
 * pass `blueprintDocSchema.safeParse` results directly. `BlueprintDoc`
 * (in-memory with `fieldParent`) is also assignable since it extends
 * `PersistableDoc`.
 *
 * Only touches the blueprint, denormalized fields, and updated_at —
 * preserves created_at, owner, run_id, and status from the original
 * save.
 */
export async function updateApp(
	appId: string,
	doc: PersistableDoc,
): Promise<void> {
	await docs.app(appId).set(
		{
			...denormalize(doc),
			blueprint: doc,
			updated_at: FieldValue.serverTimestamp(),
		},
		{ merge: true },
	);
}

/**
 * Merge-update an app during an MCP tool call, overwriting the
 * server-derived `run_id` along with the blueprint snapshot.
 *
 * The MCP surface groups event-log rows by a `run_id` that the server
 * derives from the app's own state (see `lib/mcp/runId.ts`) — clients
 * never supply one. Every event-writing MCP tool call persists the
 * current run's id back onto the app doc so (a) the next tool call
 * within the sliding window sees the same id and reuses it, and (b) the
 * app doc carries an always-current pointer to the latest run for
 * admin-surface display.
 *
 * Otherwise identical to `updateApp` — merges the blueprint,
 * denormalized fields, and `updated_at`. Run-id persistence is the only
 * addition.
 */
export async function updateAppForRun(
	appId: string,
	doc: PersistableDoc,
	runId: string,
): Promise<void> {
	await docs.app(appId).set(
		{
			...denormalize(doc),
			blueprint: doc,
			run_id: runId,
			updated_at: FieldValue.serverTimestamp(),
		},
		{ merge: true },
	);
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
 * Load just the owner userId for an app document.
 *
 * Reads only the `owner` field via an untyped document reference — avoids
 * pulling the full blueprint or running Zod validation. Used by API routes
 * that need to verify ownership before writing.
 */
export async function loadAppOwner(appId: string): Promise<string | null> {
	/* Direct untyped read — `select()` is only available on queries, not
	 * document references, so we read the raw doc and extract the one field. */
	const snap = await getDb().collection("apps").doc(appId).get();
	if (!snap.exists) return null;
	return (snap.data()?.owner as string) ?? null;
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
	"error_type",
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
	maxAgeMs: number,
): AppSummary {
	const data = doc.data();

	const createdAt = (data.created_at as Timestamp).toDate();
	const updatedAt = (data.updated_at as Timestamp)?.toDate() ?? createdAt;

	/* Timeout inference — if an app's last Firestore write was longer ago
	 * than the staleness window, the generation process is dead. Intermediate
	 * saves advance `updated_at` during generation, so an actively-running
	 * build always has a recent `updated_at`. The `failApp` write is fire-
	 * and-forget; the projected row reflects the inferred state immediately
	 * so the caller never sees stale data even if the write races. */
	const isStale =
		data.status === "generating" && now - updatedAt.getTime() > maxAgeMs;
	if (isStale) {
		failApp(doc.id, "internal");
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
 * unnecessary here because data is validated on write (completeApp,
 * updateApp) and defaults are baked in at that time.
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
export async function listApps(
	owner: string,
	options: ListAppsOptions,
): Promise<ListAppsResult> {
	const { limit, sort, status, cursor } = options;

	/* Use the untyped collection — `select()` returns partial documents that
	 * would fail the Zod converter's full-schema validation (missing owner,
	 * blueprint). Raw DocumentData is fine; `projectAppSummary` casts fields
	 * on the way out. */
	let query: FirebaseFirestore.Query = getDb()
		.collection("apps")
		.where("owner", "==", owner)
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
	const maxAgeMs = MAX_GENERATION_MINUTES * 60_000;

	/* Soft-deletes are filtered server-side — the loop is a straight
	 * 1:1 map, no per-row skip needed. */
	const apps: AppSummary[] = snap.docs.map((doc) =>
		projectAppSummary(
			doc as FirebaseFirestore.QueryDocumentSnapshot,
			now,
			maxAgeMs,
		),
	);

	/* "Maybe more" signal: a full page may have followers; a short page
	 * never does. */
	const nextCursor =
		snap.size === limit ? cursorFor(apps[apps.length - 1], sort) : undefined;

	return { apps, nextCursor };
}

/**
 * Search a user's apps by name with fuzzy matching.
 *
 * Composes on top of `listApps` rather than running its own Firestore
 * query: `listApps` is the single canonical surface that owns soft-
 * delete stripping, stale-`generating` reaping, index usage, and
 * partial-field projection. Mirroring any of that here would be a
 * drift risk. Fuse.js runs over the `listApps` page in memory, ranking
 * results by relevance (edit-distance-based scoring via the Bitap
 * algorithm) — which is also why `searchApps` has no `sort` option:
 * relevance IS the ordering.
 *
 * Pagination semantics: one `listApps` call per `searchApps` call (no
 * internal looping). `searchApps` over-fetches by `SEARCH_FETCH_BUFFER`
 * rows so a typical query produces a full page in one round trip. When
 * Fuse returns fewer than `limit` matches and `listApps` still has
 * more to scan, the underlying `listApps.nextCursor` is passed through —
 * the caller re-calls with it to search the next batch. Total matches
 * across multiple calls are bounded by what the user actually has.
 *
 * The scan uses `sort: "updated_desc"` internally — searching the
 * newest apps first gives the best average-case latency for "find my
 * recent X" queries, which is the dominant search intent. A user who
 * wants to find an old app by name will traverse more pages; they may,
 * because the cursor works.
 *
 * When Nova's per-user app count grows beyond the buffer's reach, this
 * function is the single site to swap the in-memory Fuse filter for a
 * search index (Algolia / Typesense / trigram-denormalized storage).
 * The tool schema + cursor contract on the outside remains the same.
 */
export async function searchApps(
	owner: string,
	options: SearchAppsOptions,
): Promise<SearchAppsResult> {
	const { query, limit, status, cursor } = options;

	const page = await listApps(owner, {
		limit: limit + SEARCH_FETCH_BUFFER,
		sort: "updated_desc",
		status,
		cursor,
	});

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
	 * more matches from the next `listApps` page. */
	const matches = fuse
		.search(query)
		.slice(0, limit)
		.map((result) => result.item);

	/* Cursor pass-through. A search call's "more available" signal is
	 * identical to the underlying `listApps` page's — if Firestore had
	 * more to enumerate, there may be more matches to find; if not, the
	 * user has no more apps to search. Passing the cursor through
	 * preserves that 1:1 semantic. */
	return { apps: matches, nextCursor: page.nextCursor };
}

// ── Trash query ────────────────────────────────────────────────────

/**
 * Denormalized fields fetched by `listDeletedApps`. Adds
 * `recoverable_until` to the standard summary projection so the trash
 * UI can render the "permanently deletes on DATE" copy without a
 * second read. `deleted_at` is already in `SUMMARY_FIELDS` (the active
 * list also reads it for soft-delete filtering).
 */
const DELETED_SUMMARY_FIELDS = [
	...SUMMARY_FIELDS,
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
	owner: string,
	options: ListDeletedAppsOptions,
): Promise<ListDeletedAppsResult> {
	/* Untyped collection ref for the same reason `listApps` uses one —
	 * `select()` returns partial documents that would fail the Zod
	 * converter's full-schema validation. */
	const snap = await getDb()
		.collection("apps")
		.where("owner", "==", owner)
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
