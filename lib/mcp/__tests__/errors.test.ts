/**
 * toMcpErrorResult unit tests.
 *
 * Two error-source paths to cover:
 *   - `McpAccessError` — short-circuits the classifier. Both internal
 *     reasons (`"not_found"` and `"not_owner"`) collapse to the same
 *     wire envelope per the IDOR-hardening contract documented in
 *     `../errors.ts`: a probing client sees identical text +
 *     `_meta.error_type` regardless of which internal reason applies.
 *   - Anything else — routes through `classifyError`; a bare `Error`
 *     lands in the `"internal"` bucket with the canned user message.
 *
 * Plus the shared contract that every result must satisfy:
 *   - `isError: true` is always set.
 *   - `ctx.appId`, when provided, appears on `_meta.app_id`.
 *   - `ctx.runId`, when provided, appears on `_meta.run_id`.
 *   - When no `appId` / `runId` context is given, the corresponding
 *     `_meta` key is absent (not `undefined`), so JSON-serialized
 *     envelopes don't carry a dangling key clients could mistake for a
 *     meaningful null.
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
		/* Reason-specific text. Every access-error envelope uses this
		 * same string — see the IDOR-collapse test below for the
		 * not_owner case that also lands here on the wire. */
		expect(result.content[0].text).toBe("App not found.");
	});

	it("collapses McpAccessError('not_owner') to the same wire envelope as not_found (IDOR hardening)", () => {
		/* The wire MUST NOT differentiate a cross-tenant probe from a
		 * genuine missing-id probe. An IDOR-aware client walking id
		 * space learns nothing about which ids exist if both cases
		 * produce the same text + error_type. The internal
		 * `McpAccessError.reason` stays on the class for the server-
		 * side audit log; the envelope flattens to `"not_found"`. */
		const result = toMcpErrorResult(new McpAccessError("not_owner"));
		expect(result._meta.error_type).toBe("not_found");
		expect(result.content[0].text).toBe("App not found.");
	});

	it("produces byte-identical envelopes for not_found and not_owner (IDOR regression lock)", () => {
		/* Direct regression lock: if a future change reintroduces any
		 * wire-visible signal distinguishing the two cases, stringify
		 * equality catches it immediately regardless of which
		 * specific field diverges. */
		const asMissing = toMcpErrorResult(new McpAccessError("not_found"), {
			appId: "a1",
			runId: "rid-same",
		});
		const asCrossTenant = toMcpErrorResult(new McpAccessError("not_owner"), {
			appId: "a1",
			runId: "rid-same",
		});
		expect(JSON.stringify(asMissing)).toBe(JSON.stringify(asCrossTenant));
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

	it("propagates ctx.runId onto _meta.run_id when provided", () => {
		const result = toMcpErrorResult(new Error("boom"), { runId: "rid-42" });
		expect(result._meta.run_id).toBe("rid-42");
	});

	it("omits _meta.app_id entirely when no ctx is provided", () => {
		const result = toMcpErrorResult(new Error("boom"));
		/* `in`-check rather than `toBeUndefined` so a future regression that
		 * sets the key explicitly to `undefined` (which JSON.stringify would
		 * drop but could still confuse strict-equality callers) fails. */
		expect("app_id" in result._meta).toBe(false);
		expect("run_id" in result._meta).toBe(false);
	});

	it("omits _meta.app_id when ctx is present but appId is not set", () => {
		const result = toMcpErrorResult(new Error("boom"), {});
		expect("app_id" in result._meta).toBe(false);
		expect("run_id" in result._meta).toBe(false);
	});
});
