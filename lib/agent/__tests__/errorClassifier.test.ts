import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { classifyError } from "../errorClassifier";

// `classifyError` maps raw thrown values to a stable, user-safe bucket. The
// cases that matter most are the ones the type alone can't tell apart: an
// Anthropic 5xx that arrives *mid-stream* is a plain `Error` carrying the
// provider's JSON error body, not an `APICallError` with a `statusCode`, so it
// must be recognized by message shape. These tests pin that recognition so a
// future branch reorder can't silently drop a transient upstream failure back
// into the scary `internal` bucket.
describe("classifyError", () => {
	it("buckets a mid-stream Anthropic api_error (plain Error, no statusCode) as api_server", () => {
		// Exactly the shape the SDK surfaces when a 500 lands after streaming
		// has begun — observed in production as the cause of a build that
		// failed with a generic 'internal' message.
		const err = new Error(
			'{"type":"api_error","message":"Internal server error"}',
		);
		const result = classifyError(err);
		expect(result.type).toBe("api_server");
		expect(result.message).toBe(
			"The AI service returned an error. Please try again.",
		);
		// The raw body is preserved for server-side logging.
		expect(result.raw).toContain("api_error");
	});

	it("recognizes a bare 'Internal server error' phrase as api_server", () => {
		expect(classifyError(new Error("Internal server error")).type).toBe(
			"api_server",
		);
	});

	it("still classifies an APICallError 500 as api_server", () => {
		const err = new APICallError({
			message: "boom",
			url: "https://api.anthropic.com/v1/messages",
			requestBodyValues: {},
			statusCode: 500,
			responseBody: "internal",
		});
		expect(classifyError(err).type).toBe("api_server");
	});

	it("keeps mapping overloaded / rate-limit / timeout messages to their own buckets", () => {
		expect(classifyError(new Error("Overloaded")).type).toBe("api_overloaded");
		expect(classifyError(new Error("rate_limit_error")).type).toBe(
			"api_rate_limit",
		);
		expect(classifyError(new Error("request timed out")).type).toBe(
			"api_timeout",
		);
	});

	it("falls back to internal for a genuinely unrecognized error", () => {
		expect(
			classifyError(new Error("kaboom: undefined is not a function")).type,
		).toBe("internal");
	});
});
