/**
 * Firestore document schemas and derived types.
 *
 * Zod schemas are the single source of truth — TypeScript types are derived
 * via z.infer, and Firestore converters use schema.parse() for validated reads.
 *
 * Document hierarchy:
 *
 *   usage/{userId}/months/{yyyy-mm}    → UsageDoc         (monthly actual-$ cost, accumulate-only)
 *   credits/{userId}/months/{yyyy-mm}  → CreditMonthDoc   (monthly credit balance, the resettable gate)
 *   credits/{userId}/grants/{grantId}  → CreditGrantDoc   (append-only admin reset/grant audit)
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
import { attachmentRefSchema } from "@/lib/chat/attachmentRefs";
import { mutationSchema } from "@/lib/doc/types";
import { locationSchema } from "@/lib/routing/types";
import { blueprintDocSchema } from "../domain/blueprint";
import {
	ALL_MIME_TYPES,
	ASSET_KINDS,
	MEDIA_ASSET_STATUSES,
	MEDIA_EXTRACT_STATUSES,
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

// ── Credits ─────────────────────────────────────────────────────────

/**
 * Monthly per-user credit balance — stored at `credits/{userId}/months/{yyyy-mm}`.
 *
 * The resettable *gate* ledger, parallel to `UsageDoc` but on its own
 * collection so an admin reset/grant never touches the cost record. Balance is
 * derived, not stored: `allowance + bonus − consumed`. Every quantity is a
 * non-negative integer — credits are discrete (build 100, edit 5), so a
 * fractional balance component is corruption, never a valid state.
 *
 * `allowance` has no default because its value (e.g. `2000`) is credit *policy*
 * that lives in the credit-amount module, not in this schema — baking it in here
 * would duplicate that policy and couple the two. Writers always seed `allowance`
 * explicitly in the reservation transaction, and a missing credit doc is treated
 * as a full balance by an in-code `snap.exists` check (gate and dashboard), never
 * filled by a schema default — the doc is never `parse`d into existence here.
 */
export const creditMonthDocSchema = z.object({
	/** Monthly grant, written explicitly on the first reservation of the period. */
	allowance: z.number().int().nonnegative(),
	/** Credits debited this period — the running sum of build/edit charges. */
	consumed: z.number().int().nonnegative().default(0),
	/** Additive admin grants (comps) applied to this period. */
	bonus: z.number().int().nonnegative().default(0),
	/** Last write, via FieldValue.serverTimestamp(); a Timestamp instance on read. */
	updated_at: timestamp,
});
export type CreditMonthDoc = z.infer<typeof creditMonthDocSchema>;

/**
 * Append-only audit row for one admin credit intervention — stored at
 * `credits/{userId}/grants/{grantId}`.
 *
 * Records who did what and when so a comp is traceable, and is written in the
 * same transaction as the balance mutation so audit and effect commit together.
 * This collection only ever grows; it never mutates the usage (cost) ledger.
 */
export const creditGrantDocSchema = z.object({
	/**
	 * Credits added by a grant; informational (0) for a reset, which zeroes
	 * `consumed`. Always a non-negative integer — credits are discrete, a reset
	 * writes 0 and a grant a positive whole amount, so the same
	 * `.int().nonnegative()` floor as the credit-month quantities applies.
	 */
	amount: z.number().int().nonnegative(),
	/** Which intervention this row records. */
	type: z.enum(["reset", "grant"]),
	/** Acting admin's userId. */
	actor: z.string(),
	/** Acting admin's email, denormalized so the audit list renders without a user join. */
	actor_email: z.string(),
	/** Free-text justification; null when the admin gave none. */
	reason: z.string().nullable().default(null),
	/** The yyyy-mm period the intervention affected. */
	period: z.string(),
	/** Set on write via FieldValue.serverTimestamp(); a Timestamp instance on read. */
	created_at: timestamp,
});
export type CreditGrantDoc = z.infer<typeof creditGrantDocSchema>;

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
	/** Last time settings were modified. */
	updated_at: timestamp,
});
export type UserSettingsDoc = z.infer<typeof userSettingsDocSchema>;

// ── App ─────────────────────────────────────────────────────────

export const appDocSchema = z.object({
	/** Owner userId (UUID) — the user who created this app. Used for list queries and authorization. */
	owner: z.string(),
	/**
	 * Owning Project (Better Auth organizationId) — the tenancy key for shared
	 * apps; `createApp` stamps it on every new app. Nullable only for rows that
	 * predate the field (a backfill sets it).
	 */
	project_id: z.string().nullable().default(null),
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
	/**
	 * Monotonic per-app counter, advanced by exactly one on every committed
	 * blueprint mutation batch. It is the per-app mutation stream's ordering
	 * key, the client's recovery cursor, the export version boundary, and the
	 * source for the Postgres `synced_seq` guard. `blueprint_token` keeps its
	 * optimistic-concurrency role; clients key recovery on `mutation_seq`.
	 * Defaults to 0 on rows that predate the field, and initializes on the
	 * first committed write.
	 */
	mutation_seq: z.number().int().nonnegative().default(0),
	/** Connect app type — denormalized for list filtering. Null for standard apps. */
	connect_type: z.enum(["learn", "deliver"]).nullable().default(null),
	/** Number of modules — denormalized for list display. */
	module_count: z.number().default(0),
	/** Number of forms across all modules — denormalized for list display. */
	form_count: z.number().default(0),
	/**
	 * Run-liveness status. Never feeds the validity gate — every commit
	 * gates identically whatever the status; this field exists for the
	 * liveness machinery (the concurrency guard, the staleness reaper,
	 * list display) and nothing else.
	 *
	 * - `generating` — a chat build run is in flight. `updated_at`
	 *   advances on every intermediate write; a 10-minute gap trips the
	 *   staleness inference in `listApps` and self-converts the row to
	 *   `error`.
	 * - `complete` — the at-rest state: no run is working on the app.
	 *   Every non-chat creation (MCP `create_app` included) is born here,
	 *   and the chat route flips a finished build here at drain end.
	 * - `error` — a build run failed; see `error_type` for the bucket.
	 *   Every chargeable build POST against an existing app — a retry of
	 *   a failed build or a new instruction into a finished one — claims
	 *   the run window back to `generating` (`claimRun` in build mode).
	 * - `deleted` — legacy marker, retained in the enum for back-compat
	 *   with rows soft-deleted before the marker moved off `status`.
	 *   New code uses `deleted_at != null` as the soft-delete signal
	 *   and never writes this value; lifecycle status and existence are
	 *   independent axes (see `softDeleteApp` / `restoreApp`).
	 */
	status: z
		.enum(["generating", "complete", "error", "deleted"])
		.default("complete"),
	/**
	 * True while a build is PAUSED on an `askQuestions` round — the SA halted the
	 * agent loop to await the user's answer, so the run is alive (a later POST will
	 * resume it) even though no process is currently running and `updated_at` has
	 * stopped advancing. The staleness reaper excludes `awaiting_input` rows so it
	 * never mistakes a user taking their time on a clarification for a hard-killed
	 * build and refunds its live hold. Set when the run pauses, cleared when a POST
	 * resumes it; absent on apps that never paused (and on pre-field rows, which
	 * read as not-awaiting and so stay reapable).
	 */
	awaiting_input: z.boolean().optional(),
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
	/**
	 * Optimistic-concurrency basis for whole-doc blueprint overwrites.
	 *
	 * Rotated (fresh random value) by every guarded commit — the one write
	 * path chat, MCP, and the auto-save PUT now share (`commitGuardedBatch` →
	 * `writeCommittedSnapshot` stamps a fresh `basisToken`) — plus the
	 * `scripts/recover-app.ts` writer. The auto-save PUT echoes the token it
	 * last observed; a mismatch means the stored doc advanced under it, and the
	 * overwrite is rejected (`BlueprintBasisStaleError` → 409) instead of
	 * silently erasing the other writer's work — the builder then reloads.
	 *
	 * The whole-doc token is the coarse basis; the fine-grained concurrency
	 * ground truth is the durable `acceptedMutations` / `mutation_seq` stream
	 * `commitGuardedBatch` advances per batch, which the client reconciler
	 * consumes to dedup its own echoes and merge peers' commits without a
	 * blind whole-doc overwrite.
	 * Null on rows that predate the field and on never-committed apps; a null
	 * basis matches a null stored token, so first saves need no backfill.
	 */
	blueprint_token: z.string().nullable().default(null),
	/**
	 * Durable credit-reservation marker for the refunding reaper.
	 *
	 * Written ATOMICALLY with the credit debit when a chargeable turn reserves
	 * (same `reserveCredits` transaction), so a committed charge always carries
	 * the marker its refund needs. `settled` means the hold is RESOLVED — no
	 * refund is owed: set by the refunding paths (flush / `failRun` /
	 * `reapStaleGenerating` / `reapStaleReservation`, which hand the hold back),
	 * by the atomic clean-completion writers on a KEPT charge (`completeAndSettleRun`
	 * for a build, `clearRunLockAndSettle` for an edit — each settles in the SAME
	 * transaction that makes the app claimable), and by `claimRun` (build mode) when
	 * it displaces a finished run whose charge was KEPT. The claim-window rule is what makes "stale `generating` + unsettled
	 * marker ⇒ refund it"
	 * safe: a KEPT charge's marker stays unsettled only while its app sits at
	 * `complete` — a shape the reaper never touches — and the moment a new run
	 * claims that row back to `generating`, the claim transaction marks the
	 * displaced marker settled-as-kept. A PAUSED run's unsettled marker is
	 * different in kind: it is a LIVE hold, not a kept charge — the run is
	 * alive (spared from the reaper by the `awaiting_input` flag, never by
	 * settlement), and a failed resume of it refunds off this marker (the chat
	 * route's post-flush `refundReservation`) — so the claim deliberately
	 * leaves it untouched when it displaces a paused run. Either way a
	 * `generating` row's unsettled marker only ever belongs to a hold that is
	 * still genuinely refundable (the live claim's own charge, or a
	 * displaced-paused run's live hold), so the reaper refunding off it can
	 * never un-book a charge a previous run kept — even when a hard kill lands
	 * between the claim and the new reservation. `reserved` is the exact
	 * amount to return; `period` is the month the hold actually hit (the reaper
	 * refunds that month, not whatever month it happens to run in). The marker
	 * carries NO expiry of its own: an EDIT's stranded hold (its `complete` app
	 * never enters the `generating`-keyed staleness inference) is reaped off the
	 * `run_lock`'s single liveness horizon by `reapStaleReservation` — the reaper
	 * refunds an unsettled marker only once the edit's `run_lock` is gone or past
	 * its (per-commit-refreshed) `expireAt`.
	 *
	 * Absent on apps created before this field shipped and on turns that never
	 * reserved (free continuations) — `refundReservation` treats an absent marker
	 * as a clean no-op, so those rows reap to `error` with no refund.
	 */
	reservation: z
		.object({
			period: z.string(),
			reserved: z.number(),
			settled: z.boolean(),
			/**
			 * The user whose credits the reservation debited — the run's
			 * ACTOR, NOT necessarily `owner` (a Project co-member can run a
			 * build/edit against a shared app, and per-user billing charges the
			 * one who ran it). `refundReservation` hands the hold back to THIS
			 * user. Optional: markers written before per-actor billing carry
			 * none and fall back to `owner` (the actor in the single-member
			 * world those markers were written in).
			 */
			userId: z.string().optional(),
			/**
			 * The run that booked this hold — its `run_id`, the per-run BUILD-ownership
			 * identity `runLeaseState().mine` reads (a build has no `run_lock` to carry
			 * one). It answers "does a present marker belong to a run that will resolve
			 * its OWN outcome, or to one already resolved for it?" — the reaper-race
			 * discriminator. When a run reserves, `reserveCredits` writes its `runId`;
			 * when the REAPERS resolve a stranded run they CLEAR the `runId` (keeping
			 * `userId`/`period`/`reserved`/`settled`). So a marker still carrying a `runId`
			 * is a live run that owns its terminal write (its `failApp` is correct); a
			 * marker with its `runId` CLEARED is a reaped GHOST whose stale terminal writer
			 * must NOT read it as `mine` and `failApp` a taker that re-claimed the freed app
			 * in the `[claim, reserveCredits)` window. `mine` is NON-LENIENT (an absent
			 * `runId` is nobody's), so a ghost and a legacy pre-P9 marker both read as
			 * unowned, resolved only by the reapers' OWN lenient clauses. Optional: absent
			 * on legacy pre-P9 markers, reaped markers, and free-continuation rows.
			 */
			runId: z.string().optional(),
		})
		.optional(),
	/**
	 * Exclusive edit-run lease — the per-app serialization lock an EDIT run
	 * holds while it works. An edit stays `complete` (its status never flips to
	 * `generating`), so it can't use the build path's status-as-lock; instead a
	 * chargeable edit transactionally claims this field (`claimRun('edit')`) and
	 * a concurrent build OR edit waits on it. Absent when no edit run holds the
	 * app; `claimRun` treats an absent or past-`expireAt` lock as claimable, so a
	 * hard kill that never released it (`clearRunLock`) self-heals at the lease's
	 * expiry rather than starving the next run. Builds do NOT write this — they
	 * hold the app via `status: 'generating'` — but `claimRun` reads it on both
	 * modes so a build waits on a live edit-lock and vice versa (the full
	 * cross-mode matrix).
	 */
	run_lock: z
		.object({
			/** The edit run holding the lease — the `run_id` of the claiming POST. */
			runId: z.string(),
			/** The user whose POST claimed the lease (attribution; not a tenant key). */
			actorUserId: z.string(),
			/** Absolute lease deadline (`now + MAX_RUN_MINUTES` at claim). */
			expireAt: timestamp,
		})
		.optional(),
	/** First save timestamp. Set once via FieldValue.serverTimestamp(). */
	created_at: timestamp,
	/** Updated on every save via FieldValue.serverTimestamp(). */
	updated_at: timestamp,
});
export type AppDoc = z.infer<typeof appDocSchema>;

// ── Multiplayer stream — app subcollections ────────────────────────
//
// Three subcollections under `apps/{appId}` back the real-time stream:
//
//   acceptedMutations/{seq}   the durable, ordered stream of committed
//                             mutation batches (seqDocId = padded `seq`)
//   batchDedup/{batchId}      the idempotency latch a retried PUT keys on
//   presence/{userId}:{sessionId}  the live roster, one doc per browser tab
//
// Every entry carries an absolute `expireAt` Timestamp; a Firestore TTL
// policy provisioned out-of-band on that field reaps it. Durations live in
// `lib/db/constants.ts`.

/**
 * One committed mutation batch in the durable stream, stored at
 * `apps/{appId}/acceptedMutations/{seq}` (seqDocId = `String(seq).padStart(12,
 * '0')` so lexicographic doc-id order matches numeric `seq` order). Entries
 * store the DELTA, so folding the deltas from any retained `seq` reproduces
 * the stored blueprint snapshot. The relay pipes these to browsers as SSE
 * frames; a `kind: 'migration'` entry is a stream sentinel (its `mutations`
 * are empty) that tells a client to reload rather than replay.
 */
export const acceptedMutationSchema = z.object({
	/** The monotonic `mutation_seq` this batch committed at. */
	seq: z.number().int().nonnegative(),
	/** Client-minted idempotency key — pairs with `batchDedup/{batchId}`. */
	batchId: z.string(),
	/** The SA run that produced the batch (chat/mcp); absent for an autosave. */
	runId: z.string().optional(),
	/** The committed batch's delta. Empty for a `migration` sentinel. */
	mutations: z.array(mutationSchema),
	/** The user who authored the batch (echo-classification on the client). */
	actorId: z.string(),
	/** Which write path committed the batch. */
	kind: z.enum(["autosave", "mcp", "chat", "migration"]),
	/** Commit time, via FieldValue.serverTimestamp(); a Timestamp on read. */
	ts: timestamp,
	/** TTL deadline (`now + ACCEPTED_MUTATIONS_TTL_MS`). */
	expireAt: timestamp,
});
export type AcceptedMutationDoc = z.infer<typeof acceptedMutationSchema>;

/**
 * Idempotency latch for one committed batch, stored at
 * `apps/{appId}/batchDedup/{batchId}`. The guarded writer reads it FIRST
 * inside the commit transaction: a hit short-circuits to the recorded `seq`
 * and writes nothing, so a client's retry of a not-yet-acked PUT never
 * double-commits. Carries the committed `seq` and the `basisToken`
 * (`blueprint_token`) the commit rotated to.
 */
export const batchDedupSchema = z.object({
	seq: z.number().int().nonnegative(),
	basisToken: z.string(),
	/** TTL deadline (`now + BATCH_DEDUP_TTL_MS`). */
	expireAt: timestamp,
});
export type BatchDedupDoc = z.infer<typeof batchDedupSchema>;

/**
 * One collaborator's live presence, stored at
 * `apps/{appId}/presence/{userId}:{sessionId}`. Keyed per browser session so a
 * user's two tabs don't clobber each other; the roster dedupes self by
 * `userId`. Posted on selection change and on a heartbeat; the TTL reaps a
 * tab that stopped heartbeating. `location` is validated against the same
 * `locationSchema` the routing hooks consume, so a peer's location is a
 * structurally valid builder URL on read.
 */
export const presenceDocSchema = z.object({
	userId: z.string(),
	sessionId: z.string(),
	/** Display name, denormalized from `auth_user` so the roster needs no join. */
	name: z.string(),
	/** Stable per-user avatar/marker color (`hash(userId) → palette`). */
	color: z.string(),
	/** Where this session is in the builder — a peer's avatar follows this. */
	location: locationSchema,
	/** Last heartbeat/selection-change time; the roster hides a stale entry. */
	updatedAt: timestamp,
	/** TTL deadline (`now + PRESENCE_TTL_MS`). */
	expireAt: timestamp,
});
export type PresenceDoc = z.infer<typeof presenceDocSchema>;

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
	/** Attachment manifest for a user turn — the same `AttachmentRef` shape the
	 *  live transcript + replay use, so loaded history renders the chips (and
	 *  their previews) through the one render path. */
	attachments: z.array(attachmentRefSchema).optional(),
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
 * Project-scoped, content-hash-deduped media. Lives at root collection
 * `mediaAssets/{assetId}` (the doc id is the asset's UUID; not mirrored in the
 * body). `project_id` (Project membership) gates every read/list/compile/delete
 * site — the same tenancy axis apps + case rows use; `owner` is the uploader,
 * attribution only, no longer the access gate or the GCS-path namespace.
 *
 * Root collection (not a per-app subcollection) because dedup + the library
 * picker span a whole Project, and a subcollection scope would force per-app
 * copies + a collection-group query per filter clause.
 *
 * Composite indexes (see `firestore.indexes.json`):
 *
 *   (project_id ASC, contentHash ASC, status ASC)        — dedup probe at upload
 *   (project_id ASC, status ASC, created_at DESC)        — library pagination
 *   (project_id ASC, status ASC, kind ASC, created_at DESC) — library, kind-filtered
 *
 * The shared-byte deletion guard (`hasOtherAssetForGcsObjectKey`) queries
 * `gcsObjectKey` alone — a single-field equality Firestore auto-indexes, so it
 * needs no composite entry.
 */
export const mediaAssetDocSchema = z.object({
	/**
	 * The Project (Better Auth organization) the asset belongs to — the tenant,
	 * and the ONLY access gate. Set authoritatively at upload (the app's Project
	 * for an app-context upload, else the uploader's active Project), NEVER
	 * self-asserted — so referencing a foreign asset's id can't grant access:
	 * every read / list / compile / delete site authorizes the caller's
	 * membership in THIS project_id, and the manifest filters a doc's referenced
	 * ids to it. The same tenancy axis apps + case rows use.
	 */
	project_id: z.string().min(1),
	/**
	 * User id of the uploader — provenance only (e.g. a future "uploaded by"
	 * label). NOT an access gate (that's `project_id`) and NOT in the GCS path
	 * (bytes live at `projects/<project_id>/…`). Recorded at upload.
	 */
	owner: z.string().min(1),
	/**
	 * SHA-256 of the validated bytes, lowercase hex. Computed at
	 * the validation gate from the actual stored bytes, NOT
	 * trusted from the client. Dedup key paired with `project_id`.
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
	/**
	 * Audio/video-only — duration in milliseconds, parsed from the
	 * container at confirm time. Best-effort: absent when the container
	 * exposes no duration (e.g. a video-only mp4 with no audio track),
	 * so optional even on audio/video assets. Informational only.
	 */
	durationMs: z.number().int().positive().optional(),
	/**
	 * Coarse asset kind, denormalized so the library list can filter
	 * "images only" with a server-side equality query instead of an
	 * in-memory scan over a page (which returns lopsided page sizes when
	 * one kind is sparse). One of image/audio/video (wire-attachable) or
	 * pdf/text/docx/xlsx (library-only documents). Derived at upload from
	 * the sniffed MIME (or the extension, for text); the kind is stable
	 * across the confirm step.
	 */
	kind: z.enum(ASSET_KINDS),
	/**
	 * GCS object key (without the `gs://<bucket>/` prefix) the
	 * bytes live at. Browser uploads start at a per-attempt pending key,
	 * then confirm promotes validated bytes to the content-hash final key
	 * (`users/<owner>/<contentHash>.<ext>`). Storing the key explicitly
	 * anchors the bucket layout against schema drift if the layout ever
	 * changes.
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
	/**
	 * Requirements-extract metadata for a DOCUMENT (pdf/text/docx/xlsx).
	 * Absent on media assets (image/audio/video carry no extract — they reach
	 * the model as pixels) and on a document whose extraction hasn't been
	 * triggered yet. The extract TEXT lives in GCS at
	 * `extractGcsObjectKeyFor(owner, contentHash, version)`, NOT here — a
	 * 64k-token extract would bloat every library-list read and flirt with
	 * Firestore's 1 MB doc cap. This is only the status + the metadata the UI
	 * and the chat resolve step need without fetching the body.
	 *
	 *  - `version` is the `EXTRACTOR_VERSION` the extract was produced at; a
	 *    mismatch against the current version means the stored extract is
	 *    stale and a fresh extraction is owed (the GCS key embeds it too).
	 *  - `truncated` flags an extract that hit the model's output ceiling.
	 *  - `charCount` is the extract length (for a "long document" hint in UI).
	 *  - `failureReason` is set only when `status === "failed"`.
	 *  - `title` / `summary` are a short label + a few-sentence précis of the
	 *    document, produced in the SAME single structured extraction call as the
	 *    extract (the schema writes them before the extract body, in schema order).
	 *    Both are optional/best-effort (absent when that call failed, or on an older
	 *    extractor version). They exist for a future "browse my attachments" tool
	 *    to scan attachments without opening each extract — not read by the SA.
	 */
	extract: z
		.object({
			status: z.enum(MEDIA_EXTRACT_STATUSES),
			version: z.number().int().positive(),
			model: z.string().min(1),
			truncated: z.boolean(),
			charCount: z.number().int().nonnegative(),
			extractedAt: timestamp,
			failureReason: z.string().optional(),
			title: z.string().optional(),
			summary: z.string().optional(),
		})
		.optional(),
	created_at: timestamp,
	/**
	 * Reverse index: ids of apps whose PERSISTED blueprint references this asset on
	 * some carrier. Maintained append-only by the blueprint writers
	 * (`syncMediaReferences` arrayUnions the app id on every save that references
	 * the asset) so the delete reference guard reads a tiny candidate set instead
	 * of loading every one of the owner's apps. Entries are CANDIDATES, not proof:
	 * a save never removes them, so the guard re-walks each candidate's live doc to
	 * confirm a real reference (and names the carrier) — a stale entry that no
	 * longer references the asset simply yields no carrier and doesn't block.
	 *
	 * The set is APPEND-ONLY and never pruned (no writer calls `arrayRemove`), so
	 * it grows toward the count of DISTINCT apps that ever referenced the asset —
	 * tiny for per-question field media, larger only for an asset reused as a logo
	 * across many apps. There is deliberately no prune (it would mean writes on the
	 * read-path guard); the guard re-walk tolerates stale entries at the cost of
	 * one extra app load each. If a single asset's set ever became genuinely large,
	 * the fix is a prune pass, not a re-run of the additive backfill — note that
	 * the backfill only `arrayUnion`s, so it can NEVER shrink an existing set.
	 *
	 * Ids are NOT owner-filtered: a blueprint that references a foreign asset id
	 * writes a cross-owner candidate here, harmless because the guard re-walk drops
	 * any app whose `owner` isn't the asset's owner.
	 *
	 * Server-only — never projected onto `WireMediaAsset`.
	 *
	 * `undefined` marks a row written before the index shipped and not yet
	 * backfilled. The guard full-scans those (correct, slow), so the field's value
	 * for the index's CORRECTNESS is the backfill having run before the writers go
	 * live: once a writer arrayUnions a single app onto an absent field, the field
	 * becomes DEFINED-but-partial and the full-scan fallback no longer fires, so a
	 * still-referenced asset whose other apps haven't re-saved could be wrongly
	 * deletable in that window. A one-time deploy backfill seeded the existing
	 * rows; the export media-validator is
	 * the backstop if a partial edge ever slips through. New rows are born `[]`
	 * (see `createPendingAsset`), so post-backfill no live row is `undefined`.
	 */
	referencingAppIds: z.array(z.string()).optional(),
});
export type MediaAssetDoc = z.infer<typeof mediaAssetDocSchema>;
export type MediaAssetExtract = NonNullable<MediaAssetDoc["extract"]>;
