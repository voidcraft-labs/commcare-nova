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
import { FieldValue, type Timestamp } from "@google-cloud/firestore";
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
 */
function denormalize(doc: PersistableDoc) {
	const formCount = doc.moduleOrder.reduce(
		(sum, modUuid) => sum + (doc.formOrder[modUuid]?.length ?? 0),
		0,
	);
	return {
		app_name: doc.appName || UNTITLED_APP_NAME,
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
 * Lightweight existence check — does the user own at least one app?
 *
 * Uses `limit(1)` with no field projection so it's as cheap as a
 * Firestore read can be. Called by the root page before the Suspense
 * boundary to choose between the get-started state and the app list.
 */
export async function userHasApps(owner: string): Promise<boolean> {
	const snap = await getDb()
		.collection("apps")
		.where("owner", "==", owner)
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
 * Soft-delete an app by marking `status: "deleted"` with the delete
 * timestamp and a recoverable-until deadline. The row is NOT removed
 * from Firestore — `listApps` filters `"deleted"` rows out at the
 * persistence boundary, but the blueprint, event log, and HQ
 * credentials survive so support-initiated recovery within the window
 * is a single status flip back to `"complete"`.
 *
 * A retention job (implemented outside this file) hard-deletes rows
 * past their `recoverable_until` date. 30 days mirrors the chat-side
 * support window for accidental-delete recovery.
 *
 * Returns the ISO-8601 `recoverable_until` timestamp so callers can
 * surface the deadline to users. Uses Firestore's `update()` so a
 * missing document rejects with a `NOT_FOUND` error rather than
 * materializing a partial ghost row — the write touches only the
 * three soft-delete fields, and a merge-create on a non-existent id
 * would land a row that fails the full `appDocSchema` parse (no
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
		status: "deleted",
		deleted_at: deletedAt,
		recoverable_until: recoverableUntil,
	});
	return recoverableUntil;
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

/** The denormalized fields fetched by `listApps` — no blueprint. */
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
 * List a user's apps sorted by last modified, without full blueprints.
 *
 * Queries the root-level `apps` collection filtered by `owner`. Uses
 * Firestore `select()` to fetch only the denormalized summary fields —
 * the blueprint (the large nested object) is never read. Validation is
 * unnecessary here because data is validated on write (completeApp,
 * updateApp) and defaults are baked in at that time.
 *
 * Soft-deleted rows (`status: "deleted"`) are filtered out in-memory
 * after the fetch. The filter runs post-query rather than as an
 * additional `.where("status", "!=", "deleted")` clause because
 * Firestore's inequality filters consume an index slot and would
 * require a second composite index; soft-deleted apps are rare, so the
 * in-memory skip is strictly cheaper.
 *
 * Requires composite index: `(owner ASC, updated_at DESC)`.
 */
export async function listApps(
	owner: string,
	limit = 50,
): Promise<AppSummary[]> {
	/* Use the untyped collection — `select()` returns partial documents that
	 * would fail the Zod converter's full-schema validation (missing owner,
	 * blueprint). Raw DocumentData is fine here since we cast each field below. */
	const snap = await getDb()
		.collection("apps")
		.where("owner", "==", owner)
		.select(...SUMMARY_FIELDS)
		.orderBy("updated_at", "desc")
		.limit(limit)
		.get();

	const now = Date.now();
	const maxAgeMs = MAX_GENERATION_MINUTES * 60_000;

	/* `flatMap` returns `[]` to drop a row and `[entry]` to keep it, so
	 * the soft-delete skip + timeout inference + shape projection all
	 * happen in a single pass over `snap.docs`. */
	return snap.docs.flatMap((doc) => {
		const data = doc.data();

		/* Soft-deleted rows never surface through list surfaces. Compared
		 * before any timestamp work to skip the row cheaply — a deleted
		 * row's other fields are irrelevant here. */
		if (data.status === "deleted") return [];

		const createdAt = (data.created_at as Timestamp).toDate();
		const updatedAt = (data.updated_at as Timestamp)?.toDate() ?? createdAt;

		/*
		 * Timeout inference — if an app's last Firestore write was longer ago
		 * than the staleness window, the generation process is dead. Intermediate
		 * saves advance `updated_at` during generation, so an actively-running
		 * build always has a recent `updated_at`.
		 */
		const isStale =
			data.status === "generating" && now - updatedAt.getTime() > maxAgeMs;
		if (isStale) {
			failApp(doc.id, "internal");
		}

		return [
			{
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
			},
		];
	});
}
