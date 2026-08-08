/**
 * App-state record shapes — the assembled, in-memory view of the Postgres
 * rows (`lib/db/pg.ts` owns the table types; the DDL lives in
 * `lib/case-store/migrations/20260708000000_app_state.ts`).
 *
 * Zod appears only where a jsonb column carries a shape the database can't
 * type: thread messages, the media extract, presence locations, and the
 * blueprint (validated in `lib/db/blueprintRows.ts::assembleBlueprint`).
 * Scalar columns come back typed from Kysely, so the record builders in each
 * module construct these shapes directly.
 *
 * Record hierarchy:
 *
 *   usage_months(user_id, period)    → UsageDoc         (monthly dollar cost, accumulate-only)
 *   credit_months(user_id, period)   → CreditMonthDoc   (monthly credit balance, the resettable gate)
 *   credit_grants                    → CreditGrantDoc   (append-only admin reset/grant audit)
 *   apps(id) + blueprint_entities    → AppDoc           (scalars + assembled blueprint)
 *   events                           → Event            (unified mutation+conversation log — lib/log/types)
 *   run_summaries(app_id, run_id)    → RunSummaryDoc    (per-run cost/behavior summary)
 *   threads(thread_id)               → ThreadDoc        (full conversation transcripts)
 *   app_changes(app_id, seq)         → AppChangeDoc     (the durable, PERMANENT change stream)
 *   presence(app_id, user, session)  → PresenceDoc      (live roster; expire_at-swept)
 *   media_assets / media_asset_refs  → MediaAssetDoc    (Project-scoped media metadata)
 *
 * User identity lives on `auth_users` (see lib/auth.ts).
 */

import { z } from "zod";
import type { COMMCARE_SERVER_IDS } from "@/lib/commcare/servers";
import type { Mutation } from "@/lib/doc/types";
import { type Location, locationSchema } from "@/lib/routing/types";
import type { PersistableDoc } from "../domain/blueprint";
import type {
	ALL_MIME_TYPES,
	ASSET_KINDS,
	MEDIA_ASSET_STATUSES,
} from "../domain/multimedia";
import { MEDIA_EXTRACT_STATUSES } from "../domain/multimedia";

// ── Usage ───────────────────────────────────────────────────────────

/**
 * Monthly usage aggregation — one row per user per calendar month
 * (`usage_months`), keyed by the `yyyy-mm` period so spend-cap checks are a
 * single primary-key read. Counters accumulate via `SET x = x + $delta`.
 */
export interface UsageDoc {
	input_tokens: number;
	output_tokens: number;
	cost_estimate: number;
	request_count: number;
	updated_at: Date;
}

// ── Credits ─────────────────────────────────────────────────────────

/**
 * Monthly per-user credit balance (`credit_months`) — the resettable *gate*
 * ledger, parallel to `UsageDoc` but its own table so an admin reset/grant
 * never touches the cost record. Balance is derived, not stored:
 * `allowance + bonus − consumed`. A missing row reads as a full allowance
 * everywhere (gate and dashboard share the rule), so a never-touched month
 * needs no pre-seeding write; the first chargeable turn lazily seeds the row
 * with an explicit allowance (its value is credit policy, seeded in code).
 */
export interface CreditMonthDoc {
	allowance: number;
	consumed: number;
	bonus: number;
	updated_at: Date;
}

/**
 * Append-only audit row for one admin credit intervention (`credit_grants`),
 * written in the same transaction as the balance change so audit and effect
 * commit together.
 */
export interface CreditGrantDoc {
	amount: number;
	type: "reset" | "grant";
	actor: string;
	actor_email: string;
	reason: string | null;
	period: string;
	created_at: Date;
}

// ── Per-run summary ───────────────────────────────────────────────

/**
 * Per-run cost + behavior summary (`run_summaries`), accumulated across the
 * turns of one run at finalization. Admin tools source cost breakdowns here —
 * the event log intentionally does NOT carry token usage.
 */
export const runSummaryDocSchema = z.object({
	runId: z.string(),
	/** ISO timestamp of first event written. */
	startedAt: z.string(),
	/** ISO timestamp of finalize. */
	finishedAt: z.string(),
	/** Which prompt the SA received. */
	promptMode: z.enum(["build", "edit"]),
	/** Client signal: app existed when request was sent. */
	appReady: z.boolean(),
	/** Number of modules on the blueprint at request time (0 for new builds). */
	moduleCount: z.number().int().nonnegative(),
	/** Number of agent LLM steps in the run. */
	stepCount: z.number().int().nonnegative(),
	/** SA model id (e.g. "gpt-5.6-sol"). */
	model: z.string(),
	/**
	 * Total input tokens for the run, INCLUDING cache_read_tokens and
	 * cache_write_tokens — the `estimateCost()` convention
	 * (uncachedInput = inputTokens - cacheReadTokens - cacheWriteTokens).
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

/** One HQ project space the stored API key can upload to. */
export const approvedDomainSchema = z.object({
	name: z.string(),
	displayName: z.string(),
});

/**
 * User settings (`user_settings`) — CommCare HQ credentials. Separate from
 * `auth_users` because API keys must not enter session cookies, and settings
 * grow independently of auth concerns. `commcare_api_key` stores a Cloud
 * KMS-encrypted ciphertext (base64); decryption happens server-side only.
 */
export interface UserSettingsDoc {
	commcare_username: string;
	/** Cloud KMS-encrypted CommCare HQ API key (base64). Never sent to the client. */
	commcare_api_key: string;
	/** Which CommCare HQ deployment the credentials live on (US / India / EU).
	 *  Null on a row a legacy backfill never stamped; readers collapse it to
	 *  "not configured". */
	commcare_server: (typeof COMMCARE_SERVER_IDS)[number] | null;
	/** Every project space the API key can actually upload to. */
	approved_domains: z.infer<typeof approvedDomainSchema>[];
	updated_at: Date;
}

// ── App ─────────────────────────────────────────────────────────

/** The credit-reservation marker — present when a chargeable run booked a
 *  hold (`res_period IS NOT NULL` on the row). `userId` is the CHARGED actor
 *  (refunds target it, never `owner`); `runId` is the booking run — the build
 *  ownership identity `runLeaseState().mine` reads. The reapers CLEAR `runId`
 *  when they resolve a stranded run (the reaper's signature the false-reap
 *  self-heal keys on). */
export interface AppReservation {
	period: string;
	reserved: number;
	settled: boolean;
	userId?: string;
	runId?: string;
}

/** The exclusive edit-run lease (`lock_* IS NOT NULL`). An edit stays
 *  `complete`, so this lock is its serialization primitive; a build holds via
 *  `status: 'generating'` instead and never writes one. */
export interface AppRunLock {
	runId: string;
	actorUserId: string;
	expireAt: Date;
}

/**
 * The assembled app record: the `apps` row's scalars plus the blueprint
 * reassembled from `blueprint_entities` (see `lib/db/blueprintRows.ts`).
 *
 * `app_name` is the blueprint name, which the schema keeps non-blank, so every
 * surface projects it directly.
 *
 * `status` is run-liveness only (never feeds the validity gate):
 * `generating` = a build run in flight (liveness off `updated_at` inside
 * `MAX_GENERATION_MINUTES`); `complete` = at rest; `error` = a build failed.
 * Soft-delete is represented exclusively by `deleted_at` /
 * `recoverable_until`, never by lifecycle status.
 */
export const APP_LIFECYCLE_STATUSES = [
	"generating",
	"complete",
	"error",
] as const;
export type AppLifecycleStatus = (typeof APP_LIFECYCLE_STATUSES)[number];

/** Strict database-text admission for the closed run-lifecycle vocabulary. */
export function parsePersistedAppLifecycleStatus(
	value: string,
): AppLifecycleStatus {
	if (value === "generating" || value === "complete" || value === "error") {
		return value;
	}
	throw new Error("Persisted app lifecycle status is invalid.");
}

export interface AppDoc {
	owner: string;
	project_id: string;
	app_name: string;
	blueprint: PersistableDoc;
	/** Monotonic per-app counter, advanced by exactly one on every committed
	 *  mutation batch — the stream's ordering key, the client's recovery
	 *  cursor, and the source for the Postgres `synced_seq` guard. */
	mutation_seq: number;
	connect_type: "learn" | "deliver" | null;
	module_count: number;
	form_count: number;
	status: AppLifecycleStatus;
	/** True while a run is PAUSED on an `askQuestions` round — alive with no
	 *  process. The reapers key on the lapsed lease, not this flag. */
	awaiting_input?: boolean;
	error_type: string | null;
	/** ISO-8601 soft-delete marker; null for any live row. */
	deleted_at: string | null;
	/** ISO-8601 end of the recovery window. */
	recoverable_until: string | null;
	/** Run ID of the generation/edit that last modified this app. */
	run_id: string | null;
	/** Server-minted generation of the current/last run holder. It never serves
	 * as event/thread attribution and is exposed to a client only through the
	 * actor-bound paused-continuation projection. */
	run_holder_nonce: string | null;
	reservation?: AppReservation;
	run_lock?: AppRunLock;
	created_at: Date;
	updated_at: Date;
}

// ── Multiplayer stream ──────────────────────────────────────────────

/**
 * The final durable app-change vocabulary. Browser reconciliation accepts only
 * the first three kinds; the remaining kinds are server-only state
 * transitions that force clients to reauthorize and reload.
 */
export const APP_CHANGE_KINDS = [
	"autosave",
	"mcp",
	"chat",
	"blueprint-migration",
	"fold-baseline",
	"project-move",
] as const;
export type AppChangeKind = (typeof APP_CHANGE_KINDS)[number];

export const CLIENT_APP_CHANGE_KINDS = ["autosave", "mcp", "chat"] as const;
export type ClientAppChangeKind = (typeof CLIENT_APP_CHANGE_KINDS)[number];

export type BlueprintMutationAppChangeKind =
	| ClientAppChangeKind
	| "blueprint-migration";

interface AppChangeDocBase {
	seq: number;
	batchId: string;
	runId?: string;
	actorId: string;
	ts: Date;
}

/**
 * One committed transition in the durable stream (`app_changes`). Entries
 * store the DELTA; the log is PERMANENT (no TTL, no prune) — it is both the
 * realtime catch-up stream and the app's durable edit history.
 *
 * `UNIQUE (app_id, batch_id)` is the idempotency latch a retried PUT keys on.
 * `project-move` is the only transition that changes Project scope and carries
 * its exact source and destination identities. `fold-baseline` is the only
 * other kind whose mutation batch may be empty, and its immutable
 * `app_change_fold_baselines` row supplies the fold start.
 */
export type AppChangeDoc =
	| (AppChangeDocBase & {
			kind: BlueprintMutationAppChangeKind;
			mutations: Mutation[];
			fromProjectId?: never;
			toProjectId?: never;
	  })
	| (AppChangeDocBase & {
			kind: "fold-baseline";
			mutations: [];
			fromProjectId?: never;
			toProjectId?: never;
	  })
	| (AppChangeDocBase & {
			kind: "project-move";
			mutations: Mutation[];
			fromProjectId: string;
			toProjectId: string;
	  });

/**
 * One collaborator's live presence (`presence`, keyed per browser session so
 * two tabs don't clobber). Posted on selection change and on a heartbeat;
 * rows past `expire_at` are filtered on read and swept opportunistically.
 * `location` parses against the routing schema (re-exported here for the
 * relay's roster read) so a peer's location is a structurally valid builder
 * URL on the wire.
 */
export interface PresenceDoc {
	userId: string;
	sessionId: string;
	name: string;
	image: string | null;
	email: string;
	color: string;
	location: Location;
	updatedAt: Date;
	expireAt: Date;
}
export { locationSchema };

// ── Chat Threads ──────────────────────────────────────────────────

/**
 * Chat threads (`threads`) — one row per CONVERSATION. `messages` is the
 * full `UIMessage[]` transcript (rehydrates `useChat`; resumes send it back
 * to the SA whole). Validation here is deliberately shallow — the envelope
 * only: the chat route re-validates every part against the active tool set
 * (`validateUIMessages` + `sanitizeHistoricalToolParts`) before anything
 * reaches the model, and the chat UI renders parts defensively. A deep zod
 * mirror of the AI SDK's UIMessage union would drift with every SDK bump
 * and reject history the sanitizer is designed to repair.
 */
export const threadMessageSchema = z.looseObject({
	id: z.string(),
	role: z.enum(["user", "assistant", "system"]),
	parts: z.array(z.looseObject({ type: z.string() })),
});
export type ThreadMessage = z.infer<typeof threadMessageSchema>;

/** Thread-list projection — everything the thread rows UI needs, no
 *  transcript. `activeStreamId` non-null means a run is streaming into the
 *  thread right now (the client may reconnect to it by thread id). */
export const threadMetaSchema = z.object({
	thread_id: z.string(),
	created_at: z.string(),
	updated_at: z.string(),
	thread_type: z.enum(["build", "edit"]),
	summary: z.string(),
	run_id: z.string(),
	active_stream_id: z.string().nullable(),
	message_count: z.number().int().nonnegative(),
	/** The design session this thread belongs to, when it is a build
	 * lineage's conversation (thread rows are session-targeted for their
	 * whole life). The client echoes it on every send so the route
	 * continues the session scope; null for an app-born edit thread. */
	design_session_id: z.string().nullable().optional(),
});
export type ThreadMeta = z.infer<typeof threadMetaSchema>;

export const threadDocSchema = threadMetaSchema
	.omit({ message_count: true })
	.extend({
		messages: z.array(threadMessageSchema),
		/** Transient actor-bound continuation projection. Its dedicated authority
		 * column is not part of the public thread shape or message history. */
		holder_nonce: z.string().uuid().optional(),
	});
export type ThreadDoc = z.infer<typeof threadDocSchema>;

// ── Media Assets ───────────────────────────────────────────────────

/**
 * Requirements-extract metadata for a DOCUMENT asset — stored as jsonb on the
 * row (`extractedAt` as epoch ms; jsonb carries no Date). The extract TEXT
 * lives in GCS; this is only the status + the metadata the UI and the chat
 * resolve step need without fetching the body.
 */
export const mediaAssetExtractSchema = z.object({
	status: z.enum(MEDIA_EXTRACT_STATUSES),
	version: z.number().int().positive(),
	model: z.string().min(1),
	truncated: z.boolean(),
	charCount: z.number().int().nonnegative(),
	/** Epoch ms. */
	extractedAt: z.number(),
	failureReason: z.string().optional(),
	title: z.string().optional(),
	summary: z.string().optional(),
});
export type MediaAssetExtract = z.infer<typeof mediaAssetExtractSchema>;

/**
 * Project-scoped, content-hash-deduped media metadata (`media_assets`; bytes
 * live in GCS). `project_id` is the tenant and the ONLY access gate — set
 * authoritatively at upload, never self-asserted; `owner` is upload
 * provenance only. `media_asset_refs` is the exact, Project-scoped derived
 * set of every authored Blueprint and canonical thread attachment reference.
 * Authoritative app/thread writes replace the whole set transactionally.
 */
export interface MediaAssetDoc {
	project_id: string;
	owner: string;
	/** SHA-256 of the validated bytes, lowercase hex — dedup key with project_id. */
	contentHash: string;
	/** Sniffed MIME from magic bytes — never the client's claim. */
	mimeType: (typeof ALL_MIME_TYPES)[number];
	/** Canonical extension derived from the sniffed MIME, leading dot included. */
	extension: string;
	sizeBytes: number;
	/** Image-only — width × height in pixels. */
	dimensions?: { width: number; height: number };
	/** Audio/video-only — container duration in ms; best-effort. */
	durationMs?: number;
	kind: (typeof ASSET_KINDS)[number];
	/** GCS object key (without the `gs://<bucket>/` prefix) the bytes live at. */
	gcsObjectKey: string;
	originalFilename: string;
	displayName?: string;
	/** `pending` rows are dropped by the library list; the validator gate
	 *  rejects shipping a blueprint that references one. */
	status: (typeof MEDIA_ASSET_STATUSES)[number];
	extract?: MediaAssetExtract;
	created_at: Date;
}
