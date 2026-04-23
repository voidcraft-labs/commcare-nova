/**
 * toMcpErrorResult unit tests.
 *
 * Two error-source paths to cover:
 *   - `McpAccessError` — short-circuits the classifier, carries its
 *     `reason` straight through to `_meta.error_type` with a
 *     reason-specific user-facing text (`not_found` → "App not
 *     found.", `not_owner` → "Access denied..." wording).
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
import { McpAccessError } from "../ownership";

describe("toMcpErrorResult", () => {
	it("serializes McpAccessError('not_found') with the not-found phrasing", () => {
		const result = toMcpErrorResult(new McpAccessError("not_found"));
		expect(result.isError).toBe(true);
		expect(result._meta.error_type).toBe("not_found");
		/* Reason-specific text — the old shared "Forbidden: reason" was
		 * a misnomer for `not_found` (the row genuinely isn't there,
		 * it's not a permissions denial). */
		expect(result.content[0].text).toBe("App not found.");
	});

	it("serializes McpAccessError('not_owner') with the access-denied phrasing", () => {
		const result = toMcpErrorResult(new McpAccessError("not_owner"));
		expect(result._meta.error_type).toBe("not_owner");
		expect(result.content[0].text).toMatch(/^Access denied/);
		/* The text must NOT reveal whether the row exists under another
		 * owner vs. doesn't exist at all — that's the whole point of the
		 * two-reason split staying hidden from the user-facing text. */
		expect(result.content[0].text).toContain("another user");
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
