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
 * intentionally does NOT carry token usage (spec §5: log is supplemental,
 * mutation + conversation only).
 *
 * All token counts are Anthropic-reported. `inputTokens` is the total
 * including `cacheReadTokens`; `cacheHitRate` is derived downstream
 * (`cacheReadTokens / inputTokens`).
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
	 * Domains the API key can access, tested on credential save.
	 * Safe to store permanently because API key scope
	 * and domain slugs are both immutable in CommCare HQ.
	 */
	approved_domains: z
		.array(z.object({ name: z.string(), displayName: z.string() }))
		.default([]),
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
	/** Build lifecycle status. */
	status: z.enum(["generating", "complete", "error"]).default("complete"),
	/** Error classification — set when status is 'error'. Null for non-error apps. */
	error_type: z.string().nullable().default(null),
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
