/**
 * Error classifier — inspects errors from the AI SDK / API calls and returns
 * a structured classification with a human-readable message safe for display.
 */
import { APICallError } from "ai";
import {
	AppProjectChangedError,
	CommitReauthError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";

// ── Types ──────────────────────────────────────────────────────────────

export type ErrorType =
	| "api_auth"
	| "api_rate_limit"
	| "api_overloaded"
	| "api_timeout"
	| "api_server"
	| "model_error"
	| "stream_broken"
	| "out_of_credits"
	| "generation_in_progress"
	| "run_released"
	| "access_revoked"
	| "app_changed"
	| "prompt_flagged"
	| "internal";

export interface ClassifiedError {
	type: ErrorType;
	message: string; // human-readable, safe for display
	recoverable: boolean;
	raw?: string; // original error message for logging
}

// ── User-facing messages ───────────────────────────────────────────────

export const MESSAGES: Record<ErrorType, string> = {
	api_auth: "Your API key is invalid or expired. Check Settings.",
	api_rate_limit:
		"Nova is rate limited right now. Wait a moment and try again.",
	api_overloaded: "Nova is overloaded right now. Try again shortly.",
	api_timeout: "The request timed out. Please try again.",
	api_server: "Nova ran into a server error. Please try again.",
	model_error: "Nova returned an unexpected response. Please try again.",
	stream_broken: "The connection was interrupted. Please try again.",
	out_of_credits:
		"You're out of credits for this month. They refresh on the 1st.",
	generation_in_progress:
		"You already have a build in progress. Please wait for it to finish before starting another.",
	run_released:
		"This run waited for your answer longer than its window allows, so it was released and its hold was refunded. Send your answer again to continue.",
	access_revoked:
		"You no longer have permission to edit this app, so Nova stopped. No further changes were applied.",
	app_changed:
		"This app moved to another Project while Nova was working. Nova stopped before applying the pending change. Reload to continue.",
	prompt_flagged:
		"The model provider flagged this request as a possible usage-policy violation and stopped before finishing. That happens to ordinary content now and then. Try again, or reword the request, to continue.",
	internal: "Something went wrong during generation.",
};

// ── Classifier ─────────────────────────────────────────────────────────

/**
 * Map an HTTP status from a failed model call to its user-facing bucket.
 * `body` is whatever error text is available for the "overloaded" sniff —
 * the response body on `APICallError`.
 */
function classifyByStatus(
	status: number | undefined,
	raw: string,
	body: string | undefined,
): ClassifiedError {
	// A pre-stream `invalid_prompt` is a 400 whose body carries the code; it
	// must not fall into the 400 → `model_error` arm below.
	if (body !== undefined && isPromptFlaggedText(body)) {
		return {
			type: "prompt_flagged",
			message: MESSAGES.prompt_flagged,
			recoverable: false,
			raw,
		};
	}
	if (status === 401 || status === 403) {
		return {
			type: "api_auth",
			message: MESSAGES.api_auth,
			recoverable: false,
			raw,
		};
	}
	if (status === 429) {
		return {
			type: "api_rate_limit",
			message: MESSAGES.api_rate_limit,
			recoverable: false,
			raw,
		};
	}
	if (status === 408) {
		return {
			type: "api_timeout",
			message: MESSAGES.api_timeout,
			recoverable: false,
			raw,
		};
	}
	// 400-level errors with "input" in message are usually malformed requests (model_error)
	if (status === 400) {
		return {
			type: "model_error",
			message: MESSAGES.model_error,
			recoverable: false,
			raw,
		};
	}
	// 5xx server errors
	if (status && status >= 500) {
		if (body?.toLowerCase().includes("overloaded")) {
			return {
				type: "api_overloaded",
				message: MESSAGES.api_overloaded,
				recoverable: false,
				raw,
			};
		}
		return {
			type: "api_server",
			message: MESSAGES.api_server,
			recoverable: false,
			raw,
		};
	}
	// Fallback for other API errors
	return {
		type: "api_server",
		message: MESSAGES.api_server,
		recoverable: false,
		raw,
	};
}

/**
 * OpenAI's `invalid_prompt` rejection is a moderation verdict on the whole
 * request (system prompt + transcript + tool results), not a malformed
 * request. It presents as a 400 `invalid_request_error` before streaming and
 * as a stream `error` event mid-stream, both carrying
 * `code: "invalid_prompt"` and the phrase "flagged as potentially violating
 * our usage policy". It fires on ordinary content and is not deterministic
 * across attempts, so it has its own bucket: retried like a transient fault,
 * and explained honestly when the retries run out, rather than reported as
 * a Nova-internal defect.
 */
const PROMPT_FLAGGED_CODE = "invalid_prompt";
const PROMPT_FLAGGED_PHRASE = "flagged as potentially violating";

function isPromptFlaggedText(text: string): boolean {
	return (
		text.includes(`"${PROMPT_FLAGGED_CODE}"`) ||
		text.toLowerCase().includes(PROMPT_FLAGGED_PHRASE)
	);
}

/**
 * The loggable rendering of whatever was thrown or forwarded. An `Error`
 * contributes its message. Anything else is serialized whole: once a
 * response has begun streaming the SDK can no longer throw, so the OpenAI
 * provider forwards the stream's `error` event (`{ type: "error",
 * sequence_number, error: { type, code, message, param } }`) or its
 * `response.failed` event as the VALUE of a terminal `{ type: "error" }`
 * chunk, and the chat route hands that plain object here unchanged. Coercing
 * it with `String()` rendered `[object Object]` in the log and hid the
 * provider's `code` / `message` entirely; serializing it keeps them, and
 * also lets the token sniffs below read a mid-stream record the same way they
 * read an `Error` whose message is the provider's JSON body.
 */
function rawErrorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null) {
		try {
			return JSON.stringify(error);
		} catch {
			// A self-referential object cannot serialize; the default rendering
			// still carries the classification through.
		}
	}
	return String(error);
}

export function classifyError(error: unknown): ClassifiedError {
	const raw = rawErrorText(error);

	if (error instanceof RunHolderLostError) {
		return {
			type:
				error.outcome === "released"
					? "run_released"
					: "generation_in_progress",
			message:
				error.outcome === "released"
					? "This run no longer holds the app, so Nova stopped before applying any further changes. Refresh to continue from the latest state."
					: "A newer request took over this app, so Nova stopped before applying any further changes. Refresh to continue from the latest state.",
			recoverable: false,
			raw,
		};
	}

	if (error instanceof CommitReauthError) {
		return {
			type: "access_revoked",
			message: MESSAGES.access_revoked,
			recoverable: false,
			raw,
		};
	}

	if (error instanceof AppProjectChangedError) {
		return {
			type: "app_changed",
			message: MESSAGES.app_changed,
			recoverable: false,
			raw,
		};
	}

	// AI SDK APICallError — has statusCode and responseBody
	if (APICallError.isInstance(error)) {
		return classifyByStatus(error.statusCode, raw, error.responseBody);
	}

	// Network / fetch errors
	if (error instanceof TypeError && raw.includes("fetch")) {
		return {
			type: "stream_broken",
			message: MESSAGES.stream_broken,
			recoverable: false,
			raw,
		};
	}

	// Abort errors (timeout or client disconnect)
	if (error instanceof DOMException && error.name === "AbortError") {
		return {
			type: "api_timeout",
			message: MESSAGES.api_timeout,
			recoverable: false,
			raw,
		};
	}

	// Message-pattern matching for errors that don't use APICallError. `raw`
	// is the serialized record for a forwarded mid-stream event, so every
	// sniff below reads its `type` / `code` / `message` fields too.
	const lowerMsg = raw.toLowerCase();
	if (isPromptFlaggedText(raw)) {
		return {
			type: "prompt_flagged",
			message: MESSAGES.prompt_flagged,
			recoverable: false,
			raw,
		};
	}
	if (lowerMsg.includes("overloaded")) {
		return {
			type: "api_overloaded",
			message: MESSAGES.api_overloaded,
			recoverable: false,
			raw,
		};
	}
	if (lowerMsg.includes("rate limit") || lowerMsg.includes("rate_limit")) {
		return {
			type: "api_rate_limit",
			message: MESSAGES.api_rate_limit,
			recoverable: false,
			raw,
		};
	}
	if (lowerMsg.includes("timeout") || lowerMsg.includes("timed out")) {
		return {
			type: "api_timeout",
			message: MESSAGES.api_timeout,
			recoverable: false,
			raw,
		};
	}
	// Provider 5xx server errors surface here — not in the `APICallError`
	// block above — when they arrive *mid-stream*. Once the response has begun
	// streaming, the SDK can no longer attach a `statusCode`, so the failure
	// reaches us as a plain `Error` whose message is the provider's JSON error
	// body. We match OpenAI's 5xx type token
	// (`{"type":"server_error","message":"The server had an error …"}`) with
	// its bare message phrase as a fallback, plus the generic
	// "internal server error" phrase any intermediary can emit — and bucket
	// it as `api_server`: a transient upstream failure the user can retry,
	// not a Nova-internal defect. Without this branch the error falls to the
	// `internal` bucket below, which tells the user "Something went wrong
	// during generation." — implying our bug when the fault is upstream and
	// retriable. The bucket is load-bearing beyond the message: the SDK's
	// `maxRetries` covers request *establishment* only, so a mid-stream
	// failure reaches the chat route's turn-level re-run (`turnRetry.ts`),
	// which keys on exactly these transient types.
	if (
		lowerMsg.includes("server_error") ||
		lowerMsg.includes("the server had an error") ||
		lowerMsg.includes("internal server error")
	) {
		return {
			type: "api_server",
			message: MESSAGES.api_server,
			recoverable: false,
			raw,
		};
	}

	return {
		type: "internal",
		message: MESSAGES.internal,
		recoverable: false,
		raw,
	};
}
