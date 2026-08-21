import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import {
	AppProjectChangedError,
	CommitReauthError,
} from "@/lib/db/commitGuard";
import { classifyError } from "../errorClassifier";

// `classifyError` maps raw thrown values to a stable, user-safe bucket. The
// cases that matter most are the ones the type alone can't tell apart: an
// provider 5xx that arrives *mid-stream* is a plain `Error` carrying the
// provider's JSON error body, not an `APICallError` with a `statusCode`, so it
// must be recognized by message shape. These tests pin that recognition so a
// future branch reorder can't silently drop a transient upstream failure back
// into the scary `internal` bucket.
describe("classifyError", () => {
	it("classifies authoritative access loss as a terminal revocation", () => {
		const result = classifyError(
			new CommitReauthError("You no longer have edit access."),
		);
		expect(result).toMatchObject({
			type: "access_revoked",
			message:
				"You no longer have permission to edit this app, so Nova stopped. No further changes were applied.",
			recoverable: false,
		});
	});

	it("classifies an authoritative Project change as terminal reload work", () => {
		const result = classifyError(new AppProjectChangedError());
		expect(result).toMatchObject({
			type: "app_changed",
			recoverable: false,
		});
		expect(result.message).toContain("Reload");
	});

	it("recognizes a bare 'Internal server error' phrase as api_server", () => {
		expect(classifyError(new Error("Internal server error")).type).toBe(
			"api_server",
		);
	});

	it("buckets a mid-stream OpenAI server_error (plain Error, no statusCode) as api_server", () => {
		// OpenAI's 5xx taxonomy — the shape a 500 takes when it lands after
		// streaming has begun, observed in production as the cause of a build
		// that failed with a generic 'internal' message.
		const err = new Error(
			'{"type":"server_error","message":"The server had an error while processing your request. Sorry about that!"}',
		);
		const result = classifyError(err);
		expect(result.type).toBe("api_server");
		expect(result.message).toBe(
			"Nova ran into a server error. Please try again.",
		);
		// The raw body is preserved for server-side logging.
		expect(result.raw).toContain("server_error");
	});

	it("recognizes the bare OpenAI 5xx phrase as api_server", () => {
		expect(
			classifyError(new Error("The server had an error processing this call"))
				.type,
		).toBe("api_server");
	});

	it("still classifies an APICallError 500 as api_server", () => {
		const err = new APICallError({
			message: "boom",
			url: "https://api.openai.com/v1/responses",
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

	// Once a response has begun streaming the SDK cannot throw, so the OpenAI
	// provider forwards the stream's `error` event as the VALUE of a terminal
	// `{ type: "error" }` chunk and the chat route hands that plain object to
	// the classifier unchanged. These are the exact shapes observed in
	// production; `String(object)` used to render every one of them as
	// `[object Object]` and bucket it as `internal`.
	describe("mid-stream provider events forwarded as plain objects", () => {
		const invalidPromptEvent = {
			type: "error",
			sequence_number: 84,
			error: {
				type: "invalid_request_error",
				code: "invalid_prompt",
				message:
					"Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://platform.openai.com/docs/guides/reasoning#advice-on-prompting",
				param: null,
			},
		};

		it("buckets the Responses `error` event for invalid_prompt as prompt_flagged", () => {
			const result = classifyError(invalidPromptEvent);
			expect(result.type).toBe("prompt_flagged");
			expect(result.recoverable).toBe(false);
			expect(result.message).toContain("usage-policy");
			expect(result.message).toContain("Send your message again");
		});

		it("keeps the provider's code and message in raw instead of [object Object]", () => {
			const result = classifyError(invalidPromptEvent);
			expect(result.raw).not.toContain("[object Object]");
			expect(result.raw).toContain('"invalid_prompt"');
			expect(result.raw).toContain("flagged as potentially violating");
		});

		it("buckets the Responses `response.failed` event by its nested error", () => {
			const result = classifyError({
				type: "response.failed",
				response: {
					id: "resp_1",
					status: "failed",
					error: {
						code: "invalid_prompt",
						message:
							"Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
					},
				},
			});
			expect(result.type).toBe("prompt_flagged");
		});

		it("buckets a mid-stream server_error object as api_server, like the Error form", () => {
			const result = classifyError({
				type: "error",
				sequence_number: 12,
				error: {
					type: "server_error",
					code: null,
					message:
						"The server had an error while processing your request. Sorry about that!",
					param: null,
				},
			});
			expect(result.type).toBe("api_server");
			expect(result.raw).toContain("server_error");
		});

		it("buckets a mid-stream rate_limit object as api_rate_limit", () => {
			expect(
				classifyError({
					type: "error",
					error: {
						type: "rate_limit_error",
						code: "rate_limit_exceeded",
						message: "Rate limit reached for requests",
					},
				}).type,
			).toBe("api_rate_limit");
		});

		it("falls back to internal for an unrecognized object, with its JSON in raw", () => {
			const result = classifyError({
				type: "error",
				error: { code: "mystery" },
			});
			expect(result.type).toBe("internal");
			expect(result.raw).toBe('{"type":"error","error":{"code":"mystery"}}');
		});
	});

	it("buckets a pre-stream invalid_prompt 400 as prompt_flagged, not model_error", () => {
		const err = new APICallError({
			message: "Invalid prompt",
			url: "https://api.openai.com/v1/responses",
			requestBodyValues: {},
			statusCode: 400,
			responseBody:
				'{"error":{"message":"Invalid prompt: your prompt was flagged as potentially violating our usage policy.","type":"invalid_request_error","param":null,"code":"invalid_prompt"}}',
		});
		expect(classifyError(err).type).toBe("prompt_flagged");
	});

	it("still buckets an ordinary 400 as model_error", () => {
		const err = new APICallError({
			message: "bad request",
			url: "https://api.openai.com/v1/responses",
			requestBodyValues: {},
			statusCode: 400,
			responseBody: '{"error":{"message":"Invalid schema","code":null}}',
		});
		expect(classifyError(err).type).toBe("model_error");
	});

	it("sniffs an overloaded upstream out of an APICallError 5xx body", () => {
		expect(
			classifyError(
				new APICallError({
					message: "boom",
					url: "https://api.openai.com/v1/responses",
					requestBodyValues: {},
					statusCode: 500,
					responseBody: "The engine is currently overloaded",
				}),
			).type,
		).toBe("api_overloaded");
	});
});
