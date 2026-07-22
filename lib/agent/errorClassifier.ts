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
	access_revoked:
		"You no longer have permission to edit this app, so Nova stopped. No further changes were applied.",
	app_changed:
		"This app moved to another Project while Nova was working. Nova stopped before applying the pending change. Reload to continue.",
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

export function classifyError(error: unknown): ClassifiedError {
	const raw = error instanceof Error ? error.message : String(error);

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
