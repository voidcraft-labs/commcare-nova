/**
 * Event log types — one time-ordered stream, two event families.
 *
 * `MutationEvent` captures every doc state change (actor=user or agent).
 * `ConversationEvent` captures user messages, assistant output, tool calls,
 * tool results, and classified errors. The log is supplemental: blueprint
 * state lives on the `AppDoc.blueprint` snapshot. If the event log is lost
 * or corrupt, the app still loads — only admin inspection is affected.
 *
 * Schema authority: Zod schemas below are the source of truth. TS types
 * infer via `z.infer`. Reads re-validate each stored payload via
 * `eventSchema.safeParse` (see `decodeEventsLenient`).
 *
 * Storage: one row per event in the `events` table, whose `id` identity
 * column carries no ordering semantics — every write is collision-free
 * regardless of how many requests a single run spans. Chronological order
 * is recovered at read time by ordering on `(ts, seq)` for a `run_id`
 * (see `readEvents`).
 */
import { z } from "zod";
import {
	type AttachmentRef,
	attachmentRefSchema,
} from "@/lib/chat/attachmentRefs";
import { mutationSchema } from "@/lib/doc/types";

// ── Conversation payloads ──────────────────────────────────────────

/**
 * Attachment manifest for a user message — the same `AttachmentRef` shape the
 * composer sends and the stored thread keeps, so admin inspect can show
 * what was attached, and a reader can reach the bytes (`/api/media/{assetId}`)
 * and extract (`/api/media/{assetId}/extract`) from the `assetId`. Only the
 * manifest is logged, never the extract body — that lives durably on the asset.
 */
export const conversationAttachmentSchema = attachmentRefSchema;
export type ConversationAttachment = AttachmentRef;

/**
 * Classified error payload — a small subset of `ClassifiedError` shared on
 * the log. We deliberately drop the raw stack trace: the log is not a
 * crash-report surface, and raw stacks can leak internal paths.
 */
export const classifiedErrorPayloadSchema = z.object({
	/** Classifier bucket: "api_auth" | "rate_limit" | "internal" | … */
	type: z.string(),
	/** User-safe message. */
	message: z.string(),
	/**
	 * Whether the error halted the run (terminal) versus a non-blocking error
	 * the run continued past. Read by the client to pick toast severity
	 * (error vs. warning) and the lifecycle state (failed vs. recovering);
	 * derived from the classifier's `recoverable` flag at emit time.
	 */
	fatal: z.boolean(),
});
export type ClassifiedErrorPayload = z.infer<
	typeof classifiedErrorPayloadSchema
>;

/**
 * Conversation payload discriminated union. One per chat-visible moment,
 * plus run annotations that don't surface in chat but matter for
 * debugging — `validation-attempt` records each CommCare validation
 * round's attempt number + human-readable error list, so a log reader
 * can reconstruct which errors drove which fix batch.
 *
 * `tool-call` + `tool-result` are paired by `toolCallId`; the result event
 * follows the call event in `ts` order when the tool finishes. `toolName`
 * is duplicated onto the result so downstream consumers don't need to
 * rebuild the pairing map for simple tool-usage counts.
 */
export const conversationPayloadSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("user-message"),
		text: z.string(),
		attachments: z.array(conversationAttachmentSchema).optional(),
	}),
	z.object({
		type: z.literal("assistant-text"),
		text: z.string(),
	}),
	z.object({
		type: z.literal("assistant-reasoning"),
		text: z.string(),
	}),
	z.object({
		type: z.literal("tool-call"),
		toolCallId: z.string(),
		toolName: z.string(),
		/** Tool arguments — JSON-safe. Validated lazily downstream. */
		input: z.unknown(),
	}),
	z.object({
		type: z.literal("tool-result"),
		toolCallId: z.string(),
		toolName: z.string(),
		/** Tool return value — JSON-safe. `null` when the tool returned void. */
		output: z.unknown(),
	}),
	z.object({
		type: z.literal("error"),
		error: classifiedErrorPayloadSchema,
	}),
	/* Validation-attempt annotation — emitted at the start of each CommCare
	 * validation round by the retired validate-fix loop — retained so
	 * historical runs still replay/render. `attempt` is 1-indexed; `errors`
	 * carries the human-readable errorToString results so a log reader can
	 * pair the errors with the fix:attempt-N mutations that follow. */
	z.object({
		type: z.literal("validation-attempt"),
		attempt: z.number().int().positive(),
		errors: z.array(z.string()),
	}),
	/* Step-usage annotation — one per completed agent step, carrying that
	 * step's token usage. The per-run summary (`run_summaries`) aggregates
	 * usage across steps, which cannot answer "which step re-billed uncached
	 * input" — the decomposition a prompt-cache investigation needs. This
	 * annotation is that decomposition: `inputTokens` is the step's full
	 * billed input, `cacheReadTokens` the provider-reported cached share of
	 * it, `cacheWriteTokens` the metered cache-write count when the provider
	 * reports one. A run annotation, not chat-visible content; aggregate
	 * cost stays on the run summary (see lib/log/CLAUDE.md). */
	z.object({
		type: z.literal("step-usage"),
		inputTokens: z.number().int().nonnegative(),
		outputTokens: z.number().int().nonnegative(),
		cacheReadTokens: z.number().int().nonnegative().optional(),
		cacheWriteTokens: z.number().int().nonnegative().optional(),
	}),
	/* Attachment-prep annotation — brackets the pre-Opus resolve step
	 * (`resolveAttachments`), which reads each document ref's stored extract
	 * (and lazily extracts one that has none yet). It's emitted ONLY when a
	 * document still needs extracting; a turn whose docs are already read does
	 * the resolve silently. `phase: "start"` fires before resolution begins,
	 * `"done"` after every ref is resolved; the window between them is when the UI
	 * shows a "reading documents" status. `count` (start only) is how many
	 * document attachments still needed reading, so a log reader can see how much
	 * real extraction work the turn did. Logged like `validation-attempt`: a run
	 * annotation, not chat-visible content. */
	z.object({
		type: z.literal("attachment-prep"),
		phase: z.enum(["start", "done"]),
		count: z.number().int().positive().optional(),
	}),
]);
export type ConversationPayload = z.infer<typeof conversationPayloadSchema>;

// ── Event envelope ────────────────────────────────────────────────

/**
 * Shared envelope fields. Every event carries `runId` (groups a generation
 * session — spans all requests within one chat thread), `ts` (millisecond
 * timestamp, the primary ordering key), and `seq` (per-request monotonic
 * counter, the tiebreaker when multiple events share a `ts`).
 *
 * `seq` is per-request and resets to 0 on every HTTP request — follow-up
 * turns in the same thread reset it too. Each event is its own row with a
 * server-assigned `id`, so per-request seqs cannot collide with earlier
 * requests' events on disk. Reads recover chronological order by ordering
 * on `(ts, seq)` (see `readEvents`): `ts` separates across-request
 * ordering, `seq` orders the single-millisecond bursts that SSE emissions
 * produce.
 *
 * Inter-request `ts` ordering is *mostly* monotonic because the route's
 * concurrency guard serializes same-user generations. The one known gap
 * is a client abort + immediate retry: `hasActiveGeneration`'s
 * `excludeAppId` branch lets the retry pass through, so two requests
 * with the same `runId` can produce interleaved `ts` values. Same-
 * thread interleave is semantically harmless (the user aborted the
 * first; its events are noise), but readers should treat wall-clock
 * order as approximate, not strict.
 */
const envelopeSchema = z.object({
	runId: z.string(),
	ts: z.number().int().nonnegative(),
	seq: z.number().int().nonnegative(),
	/**
	 * Which entrypoint produced this event. `"chat"` = the web chat route
	 * (`/api/chat`, SSE + session cookie). `"mcp"` = the hosted MCP
	 * endpoint (`/mcp`, HTTP JSON-RPC + OAuth bearer). The distinction
	 * exists so analytics + admin inspection can separate chat-surface
	 * events (human in the loop, visible in the builder UI) from
	 * MCP-surface events (programmatic tool calls from an external
	 * client) without reverse-engineering either from the payload.
	 *
	 * Required on every envelope — no optional, no default; every stored
	 * row carries it. See `lib/log/writer.ts` for the
	 * authoritative-stamping rule: the writer's constructor-provided
	 * source overwrites whatever the caller set, so the persisted value
	 * cannot drift from the surface that built the writer.
	 */
	source: z.enum(["chat", "mcp"]),
});

/** An agent or user mutation against the doc. */
export const mutationEventSchema = envelopeSchema.extend({
	kind: z.literal("mutation"),
	actor: z.enum(["user", "agent"]),
	/** Optional semantic tag: "scaffold" | "module:0" | "form:0-1" | "fix" | … */
	stage: z.string().optional(),
	mutation: mutationSchema,
});
export type MutationEvent = z.infer<typeof mutationEventSchema>;

/** A conversation-visible artifact from the current run. */
export const conversationEventSchema = envelopeSchema.extend({
	kind: z.literal("conversation"),
	payload: conversationPayloadSchema,
});
export type ConversationEvent = z.infer<typeof conversationEventSchema>;

/**
 * Discriminated union over both event families. Reads re-validate each
 * stored `event` payload through `eventSchema.safeParse` (see
 * `decodeEventsLenient`), so any shape drift on disk surfaces at read time
 * as a dropped-and-counted row rather than a thrown read.
 */
export const eventSchema = z.discriminatedUnion("kind", [
	mutationEventSchema,
	conversationEventSchema,
]);
export type Event = z.infer<typeof eventSchema>;
