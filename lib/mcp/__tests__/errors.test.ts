/**
 * toMcpErrorResult unit tests.
 *
 * Two error-source paths to cover:
 *   - `McpAccessError` — short-circuits the classifier. Both internal
 *     reasons (`"not_found"` and `"not_owner"`) collapse to the same
 *     wire content per the IDOR-hardening contract documented in
 *     `../errors.ts`: a probing client sees identical JSON payload
 *     regardless of which internal reason applies.
 *   - Anything else — routes through `classifyError`; a bare `Error`
 *     lands in the `"internal"` bucket with the canned user message.
 *
 * Plus the shared contract that every result must satisfy:
 *   - `isError: true` is always set.
 *   - `content[0].text` parses as JSON with `error_type` + `message`.
 *   - `ctx.appId`, when provided, appears in the JSON payload; absent
 *     when no context is given, so the payload doesn't carry a
 *     dangling key clients could mistake for a meaningful null.
 */

import { describe, expect, it } from "vitest";
import { MESSAGES } from "@/lib/agent/errorClassifier";
import { toMcpErrorResult } from "../errors";
import { McpAccessError } from "../ownership";

/**
 * Parse the JSON payload from an error result's content. Every error
 * envelope packs its structured fields into `content[0].text` as JSON,
 * so this helper makes the assertion shape one line instead of three.
 */
function parsePayload(result: { content: Array<{ text: string }> }): {
	error_type: string;
	message: string;
	app_id?: string;
} {
	return JSON.parse(result.content[0]?.text ?? "{}");
}

describe("toMcpErrorResult", () => {
	it("serializes McpAccessError('not_found') with the not-found phrasing", () => {
		const result = toMcpErrorResult(new McpAccessError("not_found"));
		expect(result.isError).toBe(true);
		const payload = parsePayload(result);
		expect(payload.error_type).toBe("not_found");
		/* Reason-specific text. Every access-error envelope uses this
		 * same string — see the IDOR-collapse test below for the
		 * not_owner case that also lands here on the wire. */
		expect(payload.message).toBe("App not found.");
	});

	it("collapses McpAccessError('not_owner') to the same wire shape as not_found (IDOR hardening)", () => {
		/* The wire MUST NOT differentiate a cross-tenant probe from a
		 * genuine missing-id probe. An IDOR-aware client walking id
		 * space learns nothing about which ids exist if both cases
		 * produce the same payload. The internal
		 * `McpAccessError.reason` stays on the class for the server-
		 * side audit log; the wire flattens to `"not_found"`. */
		const result = toMcpErrorResult(new McpAccessError("not_owner"));
		const payload = parsePayload(result);
		expect(payload.error_type).toBe("not_found");
		expect(payload.message).toBe("App not found.");
	});

	it("produces byte-identical content for not_found and not_owner (IDOR regression lock)", () => {
		/* Direct regression lock: if a future change reintroduces any
		 * wire-visible signal distinguishing the two cases, stringify
		 * equality catches it immediately regardless of which
		 * specific field diverges. */
		const asMissing = toMcpErrorResult(new McpAccessError("not_found"), {
			appId: "a1",
		});
		const asCrossTenant = toMcpErrorResult(new McpAccessError("not_owner"), {
			appId: "a1",
		});
		expect(JSON.stringify(asMissing)).toBe(JSON.stringify(asCrossTenant));
	});

	it("routes generic errors through classifyError into the internal bucket", () => {
		const result = toMcpErrorResult(new Error("boom"));
		const payload = parsePayload(result);
		expect(payload.error_type).toBe("internal");
		/* Text is the canned user-facing message, not the raw `"boom"` —
		 * surfacing raw error text to MCP clients would leak internals. */
		expect(payload.message).toBe(MESSAGES.internal);
	});

	it("propagates ctx.appId into the payload when provided", () => {
		const result = toMcpErrorResult(new Error("boom"), { appId: "app-123" });
		const payload = parsePayload(result);
		expect(payload.app_id).toBe("app-123");
	});

	it("omits app_id from the payload when no ctx is provided", () => {
		const result = toMcpErrorResult(new Error("boom"));
		const payload = parsePayload(result);
		/* `in`-check rather than `toBeUndefined` so a future regression
		 * that sets the key explicitly to `undefined` (which
		 * JSON.stringify drops at serialize time but could still
		 * confuse strict-equality callers) fails. */
		expect("app_id" in payload).toBe(false);
	});

	it("omits app_id when ctx is present but appId is not set", () => {
		const result = toMcpErrorResult(new Error("boom"), {});
		const payload = parsePayload(result);
		expect("app_id" in payload).toBe(false);
	});
});
