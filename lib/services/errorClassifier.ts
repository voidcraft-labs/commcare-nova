/**
 * Error classifier — inspects errors from the AI SDK / API calls and returns
 * a structured classification with a human-readable message safe for display.
 */
import { APICallError } from "@ai-sdk/provider";

// ── Types ──────────────────────────────────────────────────────────────

export type ErrorType =
	| "api_auth"
	| "api_rate_limit"
	| "api_overloaded"
	| "api_timeout"
	| "api_server"
	| "model_error"
	| "stream_broken"
	| "spend_cap_exceeded"
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
		"Rate limited by the AI service. Wait a moment and try again.",
	api_overloaded: "The AI service is currently overloaded. Try again shortly.",
	api_timeout: "The request timed out. Please try again.",
	api_server: "The AI service returned an error. Please try again.",
	model_error:
		"The AI model returned an unexpected response. Please try again.",
	stream_broken: "The connection was interrupted. Please try again.",
	spend_cap_exceeded:
		"You've reached your monthly usage limit. Your allowance resets on the 1st of next month.",
	internal: "Something went wrong during generation.",
};

// ── Classifier ─────────────────────────────────────────────────────────

export function classifyError(error: unknown): ClassifiedError {
	const raw = error instanceof Error ? error.message : String(error);

	// AI SDK APICallError — has statusCode and responseBody
	if (APICallError.isInstance(error)) {
		const status = error.statusCode;
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
			if (status === 529 || error.responseBody?.includes("overloaded")) {
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

	return {
		type: "internal",
		message: MESSAGES.internal,
		recoverable: false,
		raw,
	};
}
