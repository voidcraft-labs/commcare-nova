/**
 * Event log types — one time-ordered stream, two event families.
 *
 * `MutationEvent` captures every doc state change (actor=user or agent).
 * `ConversationEvent` captures user messages, assistant output, tool calls,
 * tool results, and classified errors. The log is supplemental: blueprint
 * state lives on the `AppDoc.blueprint` snapshot. If the event log is lost
 * or corrupt, the app still loads — only replay and admin inspection are
 * affected.
 *
 * Schema authority: Zod schemas below are the source of truth. TS types
 * infer via `z.infer`. Firestore reads validate via `eventSchema.parse()`.
 *
 * Storage: one document per event at `apps/{appId}/events/{autoId}`, using
 * Firestore's auto-generated 20-char IDs. Chronological order is
 * recovered at read time via `.where("runId", "==", runId).orderBy("ts").orderBy("seq")` —
 * see `readEvents`. Doc IDs themselves carry no ordering semantics; every
 * write is guaranteed collision-free regardless of how many requests a
 * single run spans.
 */
import { z } from "zod";
import { mutationSchema } from "@/lib/doc/types";

// ── Conversation payloads ──────────────────────────────────────────

/**
 * Attachment metadata for user messages. Today the builder doesn't ship
 * attachments; the shape exists so we can add file/image uploads later
 * without breaking the event log schema.
 */
export const conversationAttachmentSchema = z.object({
	name: z.string(),
	mimeType: z.string(),
	/** Firestore Storage URI or data URL, depending on pipeline. */
	uri: z.string(),
});
export type ConversationAttachment = z.infer<
	typeof conversationAttachmentSchema
>;

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
	/** True if the error halted generation; false if the auto-fixer recovered. */
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
	 * validation round by `validateAndFix`. `attempt` is 1-indexed; `errors`
	 * carries the human-readable errorToString results so a log reader can
	 * pair the errors with the fix:attempt-N mutations that follow. */
	z.object({
		type: z.literal("validation-attempt"),
		attempt: z.number().int().positive(),
		errors: z.array(z.string()),
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
 * turns in the same thread reset it too. Doc IDs are auto-generated, so
 * per-request seqs cannot collide with earlier requests' events on disk.
 * Reads recover chronological order via `orderBy("ts").orderBy("seq")`
 * (see `readEvents`): `ts` separates across-request ordering, `seq`
 * orders the single-millisecond bursts that SSE emissions produce.
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
 * Discriminated union over both event families. The Firestore converter's
 * `fromFirestore` runs `eventSchema.parse(snapshot.data())`, so any shape
 * drift on disk surfaces as a parse error at read time (caught by the
 * reader and logged via `@/lib/logger`).
 */
export const eventSchema = z.discriminatedUnion("kind", [
	mutationEventSchema,
	conversationEventSchema,
]);
export type Event = z.infer<typeof eventSchema>;
