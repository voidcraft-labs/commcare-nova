/**
 * toMcpErrorResult unit tests.
 *
 * Two error-source paths to cover:
 *   - `McpForbiddenError` — short-circuits the classifier, carries its
 *     `reason` straight through to `_meta.error_type` with a "Forbidden:"
 *     prefix on the user-facing text.
 *   - Anything else — routes through `classifyError`; a bare `Error`
 *     lands in the `"internal"` bucket with the canned user message.
 *
 * Plus the shared contract that every result must satisfy:
 *   - `isError: true` is always set.
 *   - `ctx.appId`, when provided, appears on `_meta.app_id`.
 *   - When no `appId` context is given, `_meta.app_id` is absent (not
 *     `undefined`), so JSON-serialized envelopes don't carry a dangling
 *     key clients could mistake for a meaningful null.
 */

import { describe, expect, it } from "vitest";
import { MESSAGES } from "@/lib/agent/errorClassifier";
import { toMcpErrorResult } from "../errors";
import { McpForbiddenError } from "../ownership";

describe("toMcpErrorResult", () => {
	it("serializes McpForbiddenError('not_found') with its reason as error_type", () => {
		const result = toMcpErrorResult(new McpForbiddenError("not_found"));
		expect(result.isError).toBe(true);
		expect(result._meta.error_type).toBe("not_found");
		expect(result.content[0].text).toMatch(/^Forbidden:/);
		expect(result.content[0].text).toContain("not_found");
	});

	it("serializes McpForbiddenError('not_owner') with its reason as error_type", () => {
		const result = toMcpErrorResult(new McpForbiddenError("not_owner"));
		expect(result._meta.error_type).toBe("not_owner");
		expect(result.content[0].text).toMatch(/^Forbidden:/);
		expect(result.content[0].text).toContain("not_owner");
	});

	it("routes generic errors through classifyError into the internal bucket", () => {
		const result = toMcpErrorResult(new Error("boom"));
		expect(result._meta.error_type).toBe("internal");
		/* Text is the canned user-facing message, not the raw `"boom"` —
		 * surfacing raw error text to MCP clients would leak internals. */
		expect(result.content[0].text).toBe(MESSAGES.internal);
	});

	it("propagates ctx.appId onto _meta.app_id when provided", () => {
		const result = toMcpErrorResult(new Error("boom"), { appId: "app-123" });
		expect(result._meta.app_id).toBe("app-123");
	});

	it("omits _meta.app_id entirely when no ctx is provided", () => {
		const result = toMcpErrorResult(new Error("boom"));
		/* `in`-check rather than `toBeUndefined` so a future regression that
		 * sets the key explicitly to `undefined` (which JSON.stringify would
		 * drop but could still confuse strict-equality callers) fails. */
		expect("app_id" in result._meta).toBe(false);
	});

	it("omits _meta.app_id when ctx is present but appId is not set", () => {
		const result = toMcpErrorResult(new Error("boom"), {});
		expect("app_id" in result._meta).toBe(false);
	});
});
