/**
 * Firestore document schemas and derived types.
 *
 * Zod schemas are the single source of truth — TypeScript types are derived
 * via z.infer, and Firestore converters use schema.parse() for validated reads.
 *
 * Document hierarchy:
 *
 *   usage/{userId}/months/{yyyy-mm}    → UsageDoc     (monthly spend tracking)
 *   apps/{appId}                       → AppDoc       (root-level, owner field links to user)
 *   apps/{appId}/logs/{logId}          → StoredEvent  (generation event stream)
 *   apps/{appId}/threads/{threadId}    → ThreadDoc    (chat conversation history)
 *
 * User identity lives on `auth_users` (see lib/auth.ts).
 */

import { Timestamp } from "@google-cloud/firestore";
import { z } from "zod";
import { appBlueprintSchema } from "../schemas/blueprint";

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

// ── Log Events ─────────────────────────────────────────────────────

/**
 * Log events — stored at `apps/{appId}/logs/{logId}`.
 *
 * A log is a flat, ordered stream of events. Each event is self-describing —
 * a shared envelope (who, when, ordering) wrapping one of four event variants
 * (message, step, emission, error). Each variant has exactly its own fields,
 * nothing more. No defaults for unused fields. No sparse stripping.
 *
 * StoredEvent is the unit of persistence — one Firestore document per event.
 * Replay, cost tracking, and UI displays all consume StoredEvent[] directly —
 * no intermediate format or conversion layer.
 */

/** JSON-safe value type — guarantees round-trip serialization fidelity. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

/** Token usage and cost for an LLM call. */
export interface TokenUsage {
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	cost: number;
}

/** A tool call made during an agent step. */
export interface LogToolCall {
	name: string;
	args: JsonValue;
	output: JsonValue;
	/** Inner LLM call usage. Null when the tool didn't invoke an LLM. */
	generation: TokenUsage | null;
	reasoning: string;
}

// ── Event variants ────────────────────────────────────────────────

/** User sent a chat message at the start of an HTTP request. */
export interface MessageEvent {
	type: "message";
	id: string;
	text: string;
}

/** Agent completed one LLM call (may include tool calls and their results). */
export interface StepEvent {
	type: "step";
	/** Step index within the run (0-based). Emissions reference this to associate with their parent step. */
	step_index: number;
	text: string;
	reasoning: string;
	tool_calls: LogToolCall[];
	usage: TokenUsage;
}

/** A data-* part sent to the client stream. Written immediately, not batched into steps. */
export interface EmissionEvent {
	type: "emission";
	/** Which step this emission belongs to (for replay grouping). */
	step_index: number;
	emission_type: string;
	emission_data: JsonValue;
}

/** A classified error (api_auth, rate_limit, internal, etc.). */
export interface ErrorEvent {
	type: "error";
	error_type: string;
	error_message: string;
	error_raw: string;
	error_fatal: boolean;
	error_context: string;
}

/** Discriminated union of all event payloads. */
export type LogEvent = MessageEvent | StepEvent | EmissionEvent | ErrorEvent;

// ── Stored event (envelope + event) ──────────────────────────────

/**
 * A log event with its storage envelope. This is the unit of persistence —
 * one StoredEvent = one Firestore document at `apps/{appId}/logs/{docId}`.
 */
export interface StoredEvent {
	/** Generation run ID — groups events from the same build/edit session. */
	run_id: string;
	/** Monotonic counter for deterministic ordering within a run. */
	sequence: number;
	/** HTTP request boundary (0-indexed, increments per chat request in a multi-turn). */
	request: number;
	/** ISO 8601 timestamp of this event. */
	timestamp: string;
	/** The event payload — discriminated by `event.type`. */
	event: LogEvent;
}

// ── Zod schema for Firestore reads ───────────────────────────────

/**
 * Zod schema for StoredEvent. Used by the Firestore converter to validate
 * documents on read. Writes pass through unchanged (the converter is a
 * passthrough for toFirestore).
 *
 * The discriminated union ensures each variant is validated with only its
 * own fields — no defaults for fields that don't belong to the variant.
 */
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(jsonValue),
		z.record(z.string(), jsonValue),
	]),
);

const tokenUsageSchema = z.object({
	model: z.string(),
	input_tokens: z.number(),
	output_tokens: z.number(),
	cache_read_tokens: z.number(),
	cache_write_tokens: z.number(),
	cost: z.number(),
});

const logToolCallSchema = z.object({
	name: z.string(),
	args: jsonValue,
	output: jsonValue,
	generation: tokenUsageSchema.nullable(),
	reasoning: z.string(),
});

const messageEventSchema = z.object({
	type: z.literal("message"),
	id: z.string(),
	text: z.string(),
});

const stepEventSchema = z.object({
	type: z.literal("step"),
	step_index: z.number(),
	text: z.string(),
	reasoning: z.string(),
	tool_calls: z.array(logToolCallSchema),
	usage: tokenUsageSchema,
});

const emissionEventSchema = z.object({
	type: z.literal("emission"),
	step_index: z.number(),
	emission_type: z.string(),
	emission_data: jsonValue,
});

const errorEventSchema = z.object({
	type: z.literal("error"),
	error_type: z.string(),
	error_message: z.string(),
	error_raw: z.string(),
	error_fatal: z.boolean(),
	error_context: z.string(),
});

const logEventSchema = z.discriminatedUnion("type", [
	messageEventSchema,
	stepEventSchema,
	emissionEventSchema,
	errorEventSchema,
]);

export const storedEventSchema = z.object({
	run_id: z.string(),
	sequence: z.number(),
	request: z.number(),
	timestamp: z.string(),
	event: logEventSchema,
});

// ── App ─────────────────────────────────────────────────────────

export const appDocSchema = z.object({
	/** Owner userId (UUID) — the user who created this app. Used for list queries and authorization. */
	owner: z.string(),
	/** App name — denormalized from blueprint for list display. */
	app_name: z.string(),
	/** The full blueprint, stored as a nested Firestore map. */
	blueprint: appBlueprintSchema,
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
	/** Generation run ID — links to the event log at `apps/{appId}/logs/`. */
	run_id: z.string(),
	/** Ordered array of display messages. Embedded, not a subcollection. */
	messages: z.array(storedThreadMessageSchema),
});
export type ThreadDoc = z.infer<typeof threadDocSchema>;
