/**
 * Error classifier — inspects errors from the AI SDK / API calls and returns
 * a structured classification with a human-readable message safe for display.
 */
import { GatewayError } from "@ai-sdk/gateway";
import { APICallError } from "ai";

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
		"You're out of credits for this month — they refresh on the 1st.",
	generation_in_progress:
		"You already have a build in progress. Please wait for it to finish before starting another.",
	run_released:
		"This run waited for your answer longer than its window allows, so it was released and its hold was refunded. Send your answer again to continue.",
	internal: "Something went wrong during generation.",
};

// ── Classifier ─────────────────────────────────────────────────────────

/**
 * Map an HTTP status from a failed model call to its user-facing bucket.
 * Shared by the `APICallError` branch (direct provider HTTP errors) and the
 * `GatewayError` branch (the AI Gateway wraps upstream provider failures in
 * its own `Error` subclasses that carry `statusCode` but are NOT
 * `APICallError`s — without this branch a gateway rate limit or auth failure
 * would fall through to the generic `internal` bucket).
 *
 * `body` is whatever error text is available for the "overloaded" sniff — the
 * response body on `APICallError`, the message on `GatewayError`.
 */
function classifyByStatus(
	status: number | undefined,
	raw: string,
	body: string | undefined,
): ClassifiedError {
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
	if (status === 529) {
		return {
			type: "api_overloaded",
			message: MESSAGES.api_overloaded,
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

export function classifyError(error: unknown): ClassifiedError {
	const raw = error instanceof Error ? error.message : String(error);

	// AI SDK APICallError — has statusCode and responseBody
	if (APICallError.isInstance(error)) {
		return classifyByStatus(error.statusCode, raw, error.responseBody);
	}

	// AI Gateway errors — plain `Error` subclasses carrying `statusCode`
	// (429 rate limit, 401 auth, 5xx upstream provider failures, …).
	if (GatewayError.isInstance(error)) {
		return classifyByStatus(error.statusCode, raw, raw);
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

	// Message-pattern matching for errors that don't use APICallError
	const lowerMsg = raw.toLowerCase();
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
	// body, e.g. `{"type":"api_error","message":"Internal server error"}`. We
	// match the `api_error` type token (with the bare phrase as a fallback) and
	// bucket it as `api_server`: a transient upstream failure the user can
	// retry, not a Nova-internal defect. Without this branch the error falls to
	// the `internal` bucket below, which tells the user "Something went wrong
	// during generation." — implying our bug when the fault is upstream and
	// retriable. (This corrects only the message and bucket. The SDK's
	// `maxRetries` covers request *establishment*, so a mid-stream failure is
	// still not auto-retried — the user re-runs by hand.)
	if (
		lowerMsg.includes("api_error") ||
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
