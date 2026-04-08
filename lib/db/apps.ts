/**
 * App CRUD helpers — thin wrappers over Firestore collection/document helpers.
 *
 * Provides typed, validated read/write operations for app documents.
 * All writes extract denormalized fields from the blueprint automatically
 * so list queries never need to deserialize full blueprints.
 */
import { FieldValue, type Timestamp } from "@google-cloud/firestore";
import { log } from "@/lib/log";
import type { AppBlueprint } from "../schemas/blueprint";
import type { ErrorType } from "../services/errorClassifier";
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
 * Maximum age (in minutes) before a 'generating' app is considered dead.
 *
 * Well above the 5-minute `maxDuration` route timeout — any app still
 * 'generating' after this threshold was killed by the platform or crashed
 * without writing a failure status.
 */
const MAX_GENERATION_MINUTES = 10;

// ── Helpers ────────────────────────────────────────────────────────

/** Extract denormalized fields from a blueprint for list display. */
function denormalize(blueprint: AppBlueprint) {
	const modules = blueprint.modules ?? [];
	return {
		app_name: blueprint.app_name || "Untitled",
		connect_type: blueprint.connect_type ?? null,
		module_count: modules.length,
		form_count: modules.reduce((sum, m) => sum + (m.forms?.length ?? 0), 0),
	};
}

// ── Concurrency Guard ─────────────────────────────────────────────

/**
 * Check whether the user has an active generation in progress.
 *
 * Queries for any app with `status: 'generating'` created within the last
 * 10 minutes (same stale threshold as `listApps`). Returns `true` if an
 * active generation exists that isn't the given `excludeAppId` — so retries
 * on the same build are allowed, but concurrent new builds are blocked.
 *
 * Single Firestore query with `limit(5)` — enough to find a live one
 * even if the first few results are stale or the excluded app.
 */
export async function hasActiveGeneration(
	email: string,
	excludeAppId?: string,
): Promise<boolean> {
	const snap = await getDb()
		.collection("users")
		.doc(email)
		.collection("apps")
		.where("status", "==", "generating")
		.limit(5)
		.get();

	if (snap.empty) return false;

	const now = Date.now();
	const maxAgeMs = MAX_GENERATION_MINUTES * 60_000;

	for (const doc of snap.docs) {
		if (doc.id === excludeAppId) continue;
		const createdAt = (doc.data().created_at as Timestamp)?.toDate();
		if (!createdAt) continue;

		/* Still within the generation window — a live build is in progress. */
		if (now - createdAt.getTime() <= maxAgeMs) return true;

		/* Stale — infer failure so it won't block future checks. */
		failApp(email, doc.id, "internal");
	}

	return false;
}

// ── CRUD ───────────────────────────────────────────────────────────

/**
 * Create a new app document at the start of generation.
 *
 * Called by the route handler when a new build starts (no appId from client).
 * The document starts with `status: 'generating'` and an empty blueprint —
 * `completeApp` fills in the final blueprint when generation succeeds.
 * Returns the generated appId for immediate use (logging, URL update).
 */
export async function createApp(email: string, runId: string): Promise<string> {
	const ref = collections.apps(email).doc();
	const emptyBlueprint: AppBlueprint = {
		app_name: "",
		modules: [],
		case_types: null,
	};
	await ref.set({
		...denormalize(emptyBlueprint),
		blueprint: emptyBlueprint,
		status: "generating",
		error_type: null,
		run_id: runId,
		created_at: FieldValue.serverTimestamp(),
		updated_at: FieldValue.serverTimestamp(),
	});
	return ref.id;
}

/**
 * Update an app with the final validated blueprint on generation success.
 *
 * Called by validateApp after the build pipeline completes. Updates the
 * blueprint, denormalized fields, status, and run_id — preserves created_at.
 */
export async function completeApp(
	email: string,
	appId: string,
	blueprint: AppBlueprint,
	runId: string,
): Promise<void> {
	await docs.app(email, appId).set(
		{
			...denormalize(blueprint),
			blueprint,
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
export function failApp(
	email: string,
	appId: string,
	errorType: ErrorType,
): void {
	docs
		.app(email, appId)
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
 * Merge-update an existing app with a new blueprint snapshot.
 *
 * Used by the auto-save hook after client-side edits. Uses `set` with
 * `merge: true` instead of `update` for consistency with other write paths.
 *
 * Only touches the blueprint, denormalized fields, and updated_at —
 * preserves created_at, run_id, and status from the original save.
 */
export async function updateApp(
	email: string,
	appId: string,
	blueprint: AppBlueprint,
): Promise<void> {
	await docs.app(email, appId).set(
		{
			...denormalize(blueprint),
			blueprint,
			updated_at: FieldValue.serverTimestamp(),
		},
		{ merge: true },
	);
}

/**
 * Load a single app document by ID.
 *
 * Returns the full AppDoc (including blueprint) or null if not found.
 * The Zod converter validates the document on read.
 */
export async function loadApp(
	email: string,
	appId: string,
): Promise<AppDoc | null> {
	const snap = await docs.app(email, appId).get();
	return snap.exists ? (snap.data() ?? null) : null;
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
 * Uses Firestore `select()` to fetch only the denormalized summary fields —
 * the blueprint (the large nested object) is never read. Validation is
 * unnecessary here because data is validated on write (completeApp,
 * updateApp) and defaults are baked in at that time.
 */
export async function listApps(
	email: string,
	limit = 50,
): Promise<AppSummary[]> {
	const snap = await getDb()
		.collection("users")
		.doc(email)
		.collection("apps")
		.select(...SUMMARY_FIELDS)
		.orderBy("updated_at", "desc")
		.limit(limit)
		.get();

	const now = Date.now();
	const maxAgeMs = MAX_GENERATION_MINUTES * 60_000;

	return snap.docs.map((doc) => {
		const data = doc.data();
		const createdAt = (data.created_at as Timestamp).toDate();

		/*
		 * Timeout inference — if an app has been 'generating' longer than
		 * the platform timeout allows, it's dead. Infer failure on the read
		 * path and persist the correction so it's only inferred once.
		 */
		const isStale =
			data.status === "generating" && now - createdAt.getTime() > maxAgeMs;
		if (isStale) {
			failApp(email, doc.id, "internal");
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
			updated_at: (data.updated_at as Timestamp).toDate().toISOString(),
		};
	});
}
