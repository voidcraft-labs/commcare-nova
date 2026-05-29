/**
 * Firestore document schemas and derived types.
 *
 * Zod schemas are the single source of truth — TypeScript types are derived
 * via z.infer, and Firestore converters use schema.parse() for validated reads.
 *
 * Document hierarchy:
 *
 *   usage/{userId}/months/{yyyy-mm}    → UsageDoc         (monthly spend tracking)
 *   apps/{appId}                       → AppDoc           (root-level, owner field links to user)
 *   apps/{appId}/events/{eventId}      → Event            (unified mutation+conversation log)
 *   apps/{appId}/runs/{runId}          → RunSummaryDoc    (per-run cost/behavior summary)
 *   apps/{appId}/threads/{threadId}    → ThreadDoc        (chat conversation history)
 *
 * The Event union lives in `lib/log/types.ts` — its shape is shared with
 * runtime writer/reader code. This file owns every other Firestore schema.
 *
 * User identity lives on `auth_users` (see lib/auth.ts).
 */

import { Timestamp } from "@google-cloud/firestore";
import { z } from "zod";
import { blueprintDocSchema } from "../domain/blueprint";
import {
	ALL_MIME_TYPES,
	MEDIA_ASSET_STATUSES,
	MEDIA_KINDS,
} from "../domain/multimedia";

// ── Shared ──────────────────────────────────────────────────────────

/**
 * Firestore Timestamp validator. On reads, Firestore always returns Timestamp
 * instances — this validates that invariant rather than blindly casting.
 */
const timestamp = z.instanceof(Timestamp);

// ── Usage ───────────────────────────────────────────────────────────

/**
 * Monthly usage aggregation — stored at `usage/{userId}/months/{yyyy-mm}`.
 *
 * One document per user per calendar month. The document ID is the period
 * string (e.g. "2026-04") so spend-cap checks are a single document read,
 * not a query. Fields are atomically incremented via FieldValue.increment()
 * after each run completes.
 */
export const usageDocSchema = z.object({
	/** Total input tokens consumed across all runs this period. */
	input_tokens: z.number().default(0),
	/** Total output tokens produced across all runs this period. */
	output_tokens: z.number().default(0),
	/** Estimated cost in USD, summed across all runs. */
	cost_estimate: z.number().default(0),
	/** Number of chat requests (generation runs) this period. */
	request_count: z.number().default(0),
	/** Last time this document was updated via FieldValue.serverTimestamp(). */
	updated_at: timestamp,
});
export type UsageDoc = z.infer<typeof usageDocSchema>;

// ── Per-run summary ───────────────────────────────────────────────

/**
 * Per-run cost + behavior summary written once on request finalization.
 *
 * Stored at `apps/{appId}/runs/{runId}`. Admin tools (inspect-logs,
 * inspect-compare) source cost breakdowns here — the event log itself
 * intentionally does NOT carry token usage (the log is supplemental
 * and captures mutations + conversation only).
 */
export const runSummaryDocSchema = z.object({
	runId: z.string(),
	/** ISO timestamp of first event written. */
	startedAt: z.string(),
	/** ISO timestamp of finalize. */
	finishedAt: z.string(),
	/** Which prompt the SA received. */
	promptMode: z.enum(["build", "edit"]),
	/** Fresh-edit mode (cache expired + editing). */
	freshEdit: z.boolean(),
	/** Client signal: app existed when request was sent. */
	appReady: z.boolean(),
	/** Client signal: Anthropic prompt cache TTL had lapsed. */
	cacheExpired: z.boolean(),
	/** Number of modules on the blueprint at request time (0 for new builds). */
	moduleCount: z.number().int().nonnegative(),
	/** Number of agent LLM steps in the run. */
	stepCount: z.number().int().nonnegative(),
	/** SA model id (e.g. "claude-opus-4-7"). */
	model: z.string(),
	/**
	 * Total input tokens for the run, INCLUDING cache_read_tokens and
	 * cache_write_tokens. This mirrors the existing estimateCost() convention
	 * (uncachedInput = inputTokens - cacheReadTokens - cacheWriteTokens).
	 * If Anthropic's SDK reports `input_tokens` under a different convention,
	 * adapters must convert to this contract before writing the summary.
	 *
	 * `cacheHitRate` (derived downstream) = cacheReadTokens / inputTokens.
	 */
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	cacheReadTokens: z.number().int().nonnegative(),
	cacheWriteTokens: z.number().int().nonnegative(),
	costEstimate: z.number().nonnegative(),
	toolCallCount: z.number().int().nonnegative(),
});
export type RunSummaryDoc = z.infer<typeof runSummaryDocSchema>;

// ── User Settings ──────────────────────────────────────────────

/**
 * User settings — stored at `user_settings/{userId}`.
 *
 * Separate from `auth_users` because API keys must not enter session
 * cookies (Better Auth's additionalFields propagate to sessions), and
 * settings grow independently of auth concerns.
 *
 * The `commcare_api_key` field stores a Cloud KMS-encrypted ciphertext
 * (base64-encoded). Decryption only happens server-side when proxying
 * API calls to CommCare HQ. Key rotation is handled by KMS automatically.
 */
export const userSettingsDocSchema = z.object({
	/** CommCare HQ username (typically email). */
	commcare_username: z.string(),
	/** Cloud KMS-encrypted CommCare HQ API key (base64). Never sent to the client. */
	commcare_api_key: z.string(),
	/**
	 * Every project space the API key can actually upload to — the spaces
	 * that passed an app-level access probe at credential save / refresh. An
	 * unscoped HQ key reaches every space its owner belongs to, so this can
	 * hold many; a project-scoped key holds one. The set is cached (slugs are
	 * stable) but not permanent: a user joining a new project grows it, which
	 * is what the "Refresh domains" action re-reads.
	 */
	approved_domains: z
		.array(z.object({ name: z.string(), displayName: z.string() }))
		.default([]),
	/**
	 * The user's chosen upload default — a `name` that must be one of
	 * `approved_domains`. Absent when the key reaches multiple spaces and the
	 * user hasn't picked yet; auto-set to the sole space for single-space
	 * keys. Resolution never silently falls back to `approved_domains[0]` for
	 * a multi-space key (that silent bind is the bug this field exists to
	 * prevent), so an absent default on a multi-space key is a deliberate
	 * "must choose" state, not a missing value to guess at.
	 */
	active_domain: z.string().optional(),
	/** Last time settings were modified. */
	updated_at: timestamp,
});
export type UserSettingsDoc = z.infer<typeof userSettingsDocSchema>;

// ── App ─────────────────────────────────────────────────────────

export const appDocSchema = z.object({
	/** Owner userId (UUID) — the user who created this app. Used for list queries and authorization. */
	owner: z.string(),
	/** App name — denormalized from the doc for list display. */
	app_name: z.string(),
	/**
	 * The normalized blueprint doc. Firestore persists the `BlueprintDoc`
	 * shape directly — no nested-tree conversion is needed on load.
	 *
	 * Note: `fieldParent` is NOT persisted (derived from `fieldOrder` on
	 * load), so Zod validation against `blueprintDocSchema` will succeed
	 * even when that field is absent in the stored document.
	 */
	blueprint: blueprintDocSchema,
	/** Connect app type — denormalized for list filtering. Null for standard apps. */
	connect_type: z.enum(["learn", "deliver"]).nullable().default(null),
	/** Number of modules — denormalized for list display. */
	module_count: z.number().default(0),
	/** Number of forms across all modules — denormalized for list display. */
	form_count: z.number().default(0),
	/**
	 * Build lifecycle status.
	 *
	 * - `generating` — a build is in progress. `updated_at` advances on
	 *   every intermediate write; a 10-minute gap trips the staleness
	 *   inference in `listApps` and self-converts the row to `error`.
	 * - `complete` — build finished successfully (or was created
	 *   atomically, e.g. via `create_app`).
	 * - `error` — generation failed; see `error_type` for the bucket.
	 * - `deleted` — legacy marker, retained in the enum for back-compat
	 *   with rows soft-deleted before the marker moved off `status`.
	 *   New code uses `deleted_at != null` as the soft-delete signal
	 *   and never writes this value; lifecycle status and existence are
	 *   independent axes (see `softDeleteApp` / `restoreApp`).
	 */
	status: z
		.enum(["generating", "complete", "error", "deleted"])
		.default("complete"),
	/** Error classification — set when status is 'error'. Null for non-error apps. */
	error_type: z.string().nullable().default(null),
	/**
	 * ISO-8601 timestamp marking the moment of soft-delete. Null for any
	 * live row, non-null for any deleted row — `deleted_at` is the sole
	 * soft-delete marker on this schema, fully orthogonal to `status`.
	 * Set together with `recoverable_until` by `softDeleteApp` and
	 * cleared together by `restoreApp`; lifecycle status is never
	 * touched in either direction.
	 */
	deleted_at: z.string().nullable().default(null),
	/**
	 * ISO-8601 end of the recovery window — past this, the trash UI
	 * stops surfacing the row. Null for any live row. Uses the same
	 * ISO representation as `deleted_at` so consumers computing "days
	 * remaining" work with one uniform timestamp type.
	 */
	recoverable_until: z.string().nullable().default(null),
	/** Run ID of the generation/edit that last modified this app. */
	run_id: z.string().nullable().default(null),
	/** First save timestamp. Set once via FieldValue.serverTimestamp(). */
	created_at: timestamp,
	/** Updated on every save via FieldValue.serverTimestamp(). */
	updated_at: timestamp,
});
export type AppDoc = z.infer<typeof appDocSchema>;

// ── Chat Threads ──────────────────────────────────────────────────

/**
 * Chat threads — stored at `apps/{appId}/threads/{threadId}`.
 *
 * A thread captures one conversation session (initial build or subsequent
 * edit). Messages are embedded in the document — threads are small (2–10
 * messages) and always loaded together, so a subcollection would just add
 * unnecessary reads.
 *
 * The threadId is the `runId` from that session — a 1:1 mapping that
 * also links the thread to the event log for detailed replay.
 *
 * Only display-relevant parts are stored: user text and answered
 * askQuestions. Tool calls, data-* parts, and step-start markers are
 * omitted — they're in the event log if needed for debugging.
 */

/** A visible chat part preserved for historical display. */
const storedMessagePartSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("text"),
		/** The visible text content. */
		text: z.string(),
	}),
	z.object({
		type: z.literal("askQuestions"),
		/** Tool call ID from the original UIMessage part. */
		toolCallId: z.string(),
		/** Section header the SA provided for this question block. */
		header: z.string(),
		/** Flattened question–answer pairs — just the text, no options array. */
		questions: z.array(
			z.object({
				question: z.string(),
				answer: z.string(),
			}),
		),
	}),
]);
export type StoredMessagePart = z.infer<typeof storedMessagePartSchema>;

/** A single display message within a stored thread. */
const storedThreadMessageSchema = z.object({
	/** Original UIMessage ID — used for deduplication on incremental saves. */
	id: z.string(),
	role: z.enum(["user", "assistant"]),
	/** Visible parts only — text and answered askQuestions. */
	parts: z.array(storedMessagePartSchema),
});
export type StoredThreadMessage = z.infer<typeof storedThreadMessageSchema>;

/** Thread document at `apps/{appId}/threads/{threadId}`. */
export const threadDocSchema = z.object({
	/** ISO 8601 timestamp when the thread started. */
	created_at: z.string(),
	/** Whether this was the initial build or a subsequent edit session. */
	thread_type: z.enum(["build", "edit"]),
	/** First user message text, truncated to ~200 chars — for collapsed display. */
	summary: z.string(),
	/** Generation run ID — links to the event log at `apps/{appId}/events/`. */
	run_id: z.string(),
	/** Ordered array of display messages. Embedded, not a subcollection. */
	messages: z.array(storedThreadMessageSchema),
});
export type ThreadDoc = z.infer<typeof threadDocSchema>;

// ── Media Assets ───────────────────────────────────────────────────

/**
 * Per-owner content-hash-deduped media. Lives at root collection
 * `mediaAssets/{assetId}` (the doc id is the asset's UUID; not
 * mirrored in the body). `owner` gates every read site.
 *
 * Two reasons this is a root collection rather than a per-app
 * subcollection:
 *
 *  1. Dedup follows the owner, not the app — a logo reused across
 *     three apps is one row, not three. A subcollection scope
 *     would force per-app copies.
 *  2. The library picker shows all of a user's assets at once;
 *     querying across apps from a subcollection requires a
 *     collection-group query, which costs an additional index per
 *     filter clause.
 *
 * Composite indexes (see `firestore.indexes.json`):
 *
 *   (owner ASC, contentHash ASC) — dedup probe at upload-initiate
 *   (owner ASC, createdAt DESC)  — library pagination, newest first
 */
export const mediaAssetDocSchema = z.object({
	/**
	 * User id of the asset's owner. Every read site enforces
	 * `asset.owner === session.user.id` before returning bytes
	 * or metadata.
	 */
	owner: z.string().min(1),
	/**
	 * SHA-256 of the validated bytes, lowercase hex. Computed at
	 * the validation gate from the actual stored bytes, NOT
	 * trusted from the client. Dedup key paired with `owner`.
	 */
	contentHash: z.string().regex(/^[a-f0-9]{64}$/),
	/**
	 * Sniffed MIME from `file-type`'s magic-bytes scan — NOT the
	 * client's claim. Constrained to the shared accepted-types set.
	 */
	mimeType: z.enum(ALL_MIME_TYPES),
	/**
	 * Canonical extension derived from the sniffed MIME, leading
	 * dot included. Forms the suffix of the GCS object key.
	 */
	extension: z.string().regex(/^\.[a-z0-9]+$/),
	sizeBytes: z.number().int().positive(),
	/** Image-only — width × height in pixels. Read by sharp at confirm time. */
	dimensions: z
		.object({
			width: z.number().int().positive(),
			height: z.number().int().positive(),
		})
		.optional(),
	/** Audio/video-only — duration in milliseconds, derived by ffprobe at confirm time. */
	durationMs: z.number().int().positive().optional(),
	/**
	 * Coarse media kind, denormalized so the library list can filter
	 * "images only" with a server-side equality query instead of an
	 * in-memory scan over a page (which returns lopsided page sizes
	 * when one kind is sparse). Derived from the sniffed MIME at
	 * upload and frozen — the confirm step never changes the kind
	 * because a sniffed MIME that disagrees with the claim is
	 * rejected, not stored.
	 */
	kind: z.enum(MEDIA_KINDS),
	/**
	 * GCS object key (without the `gs://<bucket>/` prefix) the
	 * bytes live at — `users/<owner>/<contentHash>.<ext>`. The
	 * key is reconstructible from `(owner, contentHash, extension)`;
	 * storing it explicitly anchors the bucket layout against schema
	 * drift if the layout ever changes.
	 */
	gcsObjectKey: z.string().min(1),
	/** Filename as supplied by the client at upload. Display only. */
	originalFilename: z.string().min(1),
	/**
	 * User-editable display name, set to `originalFilename` at
	 * upload. The library UI lets the user rename without affecting
	 * the underlying bytes.
	 */
	displayName: z.string().min(1).optional(),
	/**
	 * Lifecycle status. `pending` rows are dropped by the
	 * library-list endpoint; the validator gate rejects shipping
	 * any blueprint that still references a `pending` asset. The
	 * confirm step flips this to `ready` once the validator
	 * approves the bytes; on failure the row is deleted, so there
	 * is no `failed` state to track.
	 */
	status: z.enum(MEDIA_ASSET_STATUSES),
	created_at: timestamp,
});
export type MediaAssetDoc = z.infer<typeof mediaAssetDocSchema>;
