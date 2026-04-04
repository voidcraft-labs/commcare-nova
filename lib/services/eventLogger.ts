/**
 * EventLogger — flat event stream logger with Firestore sink.
 *
 * A log is a flat, ordered stream of events. Every event is a self-describing
 * StoredEvent — one object that writes identically to the Firestore sink.
 *
 * **Firestore sink** (enableFirestore): writes one document per event to
 * `users/{email}/apps/{appId}/logs/`. Fire-and-forget — a Firestore
 * outage never blocks generation.
 */
import type { UIMessage } from "ai";
import { writeLogEvent } from "../db/logs";
import type {
	JsonValue,
	LogEvent,
	LogToolCall,
	StoredEvent,
	TokenUsage,
} from "../db/types";
import { incrementUsage } from "../db/usage";
import { log } from "../log";
import { DEFAULT_PRICING, MODEL_PRICING } from "../models";
import type { ClassifiedError } from "./errorClassifier";

// ── Constants ───────────────────────────────────────────────────────

const SKIP_EMISSIONS = new Set(["data-partial-scaffold", "data-run-id"]);

// ── EventLogger ─────────────────────────────────────────────────────

export class EventLogger {
	private _runId: string;

	/* Firestore sink */
	private fsEmail: string | null = null;
	private fsAppId: string | null = null;

	/* Ordering */
	private sequence = 0;
	private requestNumber = 0;
	private stepIndex = 0;

	/* Buffered sub-generation results matched into the next step event by logStep() */
	private pendingSubResults: Array<{
		label: string;
		usage: TokenUsage;
		reasoning: string;
	}> = [];

	/* Request-level cost accumulator — flushed once in finalize(). */
	private _usageInputTokens = 0;
	private _usageOutputTokens = 0;
	private _usageCost = 0;
	private _finalized = false;

	constructor(existingRunId?: string) {
		this._runId = existingRunId ?? crypto.randomUUID();
	}

	get runId(): string {
		return this._runId;
	}

	/**
	 * Enable real-time Firestore logging. Each emit/logStep/logError/logMessage
	 * call writes a document to `users/{email}/apps/{appId}/logs/`.
	 */
	enableFirestore(email: string, appId: string) {
		this.fsEmail = email;
		this.fsAppId = appId;
	}

	private get firestoreEnabled(): boolean {
		return this.fsEmail !== null && this.fsAppId !== null;
	}

	// ── Core: write a StoredEvent to the Firestore sink ───────────────

	private write(event: LogEvent) {
		if (!this.firestoreEnabled) return;

		const stored: StoredEvent = {
			run_id: this._runId,
			sequence: this.sequence++,
			request: this.requestNumber,
			timestamp: new Date().toISOString(),
			event,
		};

		if (!this.fsEmail || !this.fsAppId) return;
		writeLogEvent(this.fsEmail, this.fsAppId, stored);
	}

	// ── Public API ──────────────────────────────────────────────────

	/**
	 * Log user messages from the current request. Extracts user-role messages
	 * and writes one message event per user message in the current request.
	 */
	logConversation(messages: UIMessage[]) {
		if (!this.firestoreEnabled) return;

		const userMessages = messages
			.filter((m) => m.role === "user")
			.map((m) => ({
				id: m.id,
				text: m.parts
					.filter((p: { type: string }) => p.type === "text")
					.map((p: { type: string; text?: string }) => p.text ?? "")
					.join("\n"),
			}));

		/* Write only the current request's user message — previous messages were
		 * written by previous requests. */
		const currentMsg = userMessages[this.requestNumber];
		if (currentMsg) {
			this.write({ type: "message", id: currentMsg.id, text: currentMsg.text });
		}
	}

	/** Write an emission event immediately (real-time, not batched). */
	logEmission(type: string, data: unknown) {
		if (!this.firestoreEnabled) return;
		if (SKIP_EMISSIONS.has(type)) return;

		this.write({
			type: "emission",
			step_index: this.stepIndex,
			emission_type: type,
			emission_data: structuredClone(data) as JsonValue,
		});
	}

	/** Write an error event immediately. */
	logError(error: ClassifiedError, context?: string) {
		if (!this.firestoreEnabled) return;
		this.write({
			type: "error",
			error_type: error.type,
			error_message: error.message,
			error_raw: error.raw ?? "",
			error_fatal: !error.recoverable,
			error_context: context ?? "",
		});
	}

	/** Buffer a sub-generation result to be matched into the next logStep. */
	logSubResult(
		label: string,
		result: {
			model: string;
			input_tokens: number;
			output_tokens: number;
			cache_read_tokens?: number;
			cache_write_tokens?: number;
			input?: unknown;
			output?: unknown;
			reasoningText?: string;
		},
	) {
		if (!this.firestoreEnabled) return;
		this.pendingSubResults.push({
			label,
			usage: {
				model: result.model,
				input_tokens: result.input_tokens,
				output_tokens: result.output_tokens,
				cache_read_tokens: result.cache_read_tokens ?? 0,
				cache_write_tokens: result.cache_write_tokens ?? 0,
				cost: estimateCost(
					result.model,
					result.input_tokens,
					result.output_tokens,
					result.cache_read_tokens,
					result.cache_write_tokens,
				),
			},
			reasoning: result.reasoningText ?? "",
		});
	}

	/**
	 * Write a step event for a completed agent turn. Matches tool results from
	 * the SDK callback to their tool calls by toolCallId, and drains any
	 * buffered sub-generation results by name.
	 */
	logStep(step: {
		text?: string;
		reasoning?: string;
		tool_calls?: Array<{ name: string; args: unknown; toolCallId?: string }>;
		tool_results?: Array<{ toolCallId: string; output: unknown }>;
		usage: {
			model: string;
			input_tokens: number;
			output_tokens: number;
			cache_read_tokens?: number;
			cache_write_tokens?: number;
		};
	}) {
		if (!this.firestoreEnabled) return;

		/* Build toolCallId → output lookup from SDK tool results */
		const resultsByCallId = new Map<string, unknown>();
		for (const tr of step.tool_results ?? []) {
			resultsByCallId.set(tr.toolCallId, tr.output);
		}

		/* Match tool calls to SDK results (by ID) and buffered sub-results (by name) */
		const toolCalls: LogToolCall[] = (step.tool_calls ?? []).map((tc) => {
			const directOutput =
				tc.toolCallId != null ? resultsByCallId.get(tc.toolCallId) : undefined;
			const subIdx = this.pendingSubResults.findIndex((sr) =>
				labelMatchesToolName(sr.label, tc.name),
			);
			const subResult =
				subIdx >= 0 ? this.pendingSubResults.splice(subIdx, 1)[0] : undefined;
			return {
				name: tc.name,
				args: tc.args as JsonValue,
				output: (directOutput !== undefined ? directOutput : null) as JsonValue,
				generation: subResult?.usage ?? null,
				reasoning: subResult?.reasoning ?? "",
			};
		});

		this.pendingSubResults = [];

		const usage: TokenUsage = {
			model: step.usage.model,
			input_tokens: step.usage.input_tokens,
			output_tokens: step.usage.output_tokens,
			cache_read_tokens: step.usage.cache_read_tokens ?? 0,
			cache_write_tokens: step.usage.cache_write_tokens ?? 0,
			cost: estimateCost(
				step.usage.model,
				step.usage.input_tokens,
				step.usage.output_tokens,
				step.usage.cache_read_tokens,
				step.usage.cache_write_tokens,
			),
		};

		/* Accumulate cost for the single flush in finalize(). Includes both the
		 * outer agent step and any inner LLM calls from tools. */
		this._usageInputTokens += usage.input_tokens;
		this._usageOutputTokens += usage.output_tokens;
		this._usageCost += usage.cost;
		for (const tc of toolCalls) {
			if (tc.generation) {
				this._usageInputTokens += tc.generation.input_tokens;
				this._usageOutputTokens += tc.generation.output_tokens;
				this._usageCost += tc.generation.cost;
			}
		}

		this.write({
			type: "step",
			step_index: this.stepIndex,
			text: step.text ?? "",
			reasoning: step.reasoning ?? "",
			tool_calls: toolCalls,
			usage,
		});

		this.stepIndex++;
	}

	/**
	 * Flush accumulated usage to Firestore (single write per request).
	 * Idempotent via `_finalized` guard — safe to call from multiple sites
	 * (execute finally, onFinish, abort handler) without double-writing.
	 *
	 * On failure, logs and moves on — the pre-request getMonthlyUsage()
	 * read is the fail-closed gate (see lib/db/usage.ts).
	 */
	async finalize(): Promise<void> {
		if (this._finalized) return;
		this._finalized = true;

		if (this.firestoreEnabled && this._usageCost > 0) {
			try {
				await incrementUsage(this.fsEmail ?? "", {
					input_tokens: this._usageInputTokens,
					output_tokens: this._usageOutputTokens,
					cost_estimate: this._usageCost,
				});
			} catch (err) {
				log.error("[finalize] usage increment failed", err, {
					email: this.fsEmail ?? "",
				});
			}
		}
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Estimate USD cost from token counts using MODEL_PRICING. */
export function estimateCost(
	model: string,
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens?: number,
	cacheWriteTokens?: number,
): number {
	const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
	const uncachedInput =
		inputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0);
	return (
		(uncachedInput * pricing.input +
			(cacheReadTokens ?? 0) * pricing.cacheRead +
			(cacheWriteTokens ?? 0) * pricing.cacheWrite +
			outputTokens * pricing.output) /
		1_000_000
	);
}

/** Match sub-result labels to tool names for step grouping. */
function labelMatchesToolName(label: string, toolName: string): boolean {
	const prefix = label.split(/[:\s]/)[0].toLowerCase();
	switch (prefix) {
		case "schema":
			return toolName === "generateSchema";
		case "scaffold":
			return toolName === "generateScaffold";
		case "module":
			return toolName === "addModule";
		case "generate":
			return toolName === "addForm";
		case "fixer":
			return toolName === "validateApp";
		default:
			return false;
	}
}
