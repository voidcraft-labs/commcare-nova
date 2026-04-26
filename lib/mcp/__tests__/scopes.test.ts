/**
 * parseScopes + assertScope + SCOPES unit tests.
 *
 * `parseScopes` properties:
 *   - Multi-token claims split on whitespace into ordered arrays.
 *   - Missing `scope` claims produce `[]`, never `undefined` or
 *     `[""]` (both of which would break the caller's `.includes` check).
 *   - Whitespace-only claims produce `[]`, matching the "missing" case.
 *
 * `assertScope` properties:
 *   - Granted scope resolves cleanly.
 *   - Missing scope throws `McpScopeError` carrying both the required
 *     scope and the tool name. The error serializer (covered in
 *     `errors.test.ts`) is responsible for the wire shape; this file
 *     verifies only that the throw carries the right metadata.
 */

import { describe, expect, it } from "vitest";
import { assertScope, McpScopeError, parseScopes, SCOPES } from "../scopes";

describe("parseScopes", () => {
	it("splits a space-separated scope claim into tokens in order", () => {
		expect(parseScopes("nova.read nova.write openid")).toEqual([
			"nova.read",
			"nova.write",
			"openid",
		]);
	});

	it("returns [] when the scope claim is absent", () => {
		expect(parseScopes(undefined)).toEqual([]);
	});

	it("returns [] when the scope claim is whitespace-only", () => {
		expect(parseScopes("   ")).toEqual([]);
	});

	it("collapses runs of internal whitespace without emitting empty tokens", () => {
		/* Defensive: some token servers emit CRLF-separated scopes or
		 * accidentally double-space them. The split regex handles any
		 * whitespace run, and `filter(Boolean)` drops the empty strings
		 * that leading/trailing whitespace would otherwise produce. */
		expect(parseScopes("  nova.read\t nova.write  ")).toEqual([
			"nova.read",
			"nova.write",
		]);
	});
});

describe("SCOPES", () => {
	it("exposes the canonical scope string literals", () => {
		/* Pins the wire values — changing them is a breaking change for
		 * every issued access token, so this test is a tripwire that
		 * forces anyone renaming to acknowledge the impact. */
		expect(SCOPES.read).toBe("nova.read");
		expect(SCOPES.write).toBe("nova.write");
		expect(SCOPES.hqRead).toBe("nova.hq.read");
		expect(SCOPES.hqWrite).toBe("nova.hq.write");
	});
});

describe("assertScope", () => {
	it("resolves cleanly when the required scope is granted", () => {
		expect(() =>
			assertScope(
				[SCOPES.read, SCOPES.write, SCOPES.hqRead],
				SCOPES.hqRead,
				"get_hq_connection",
			),
		).not.toThrow();
	});

	it("ignores third-party scopes alongside the required one", () => {
		/* OIDC + refresh-token scopes ride alongside Nova scopes on every
		 * token. The `.includes` check must look at the full array, not
		 * a Nova-only filtered view. */
		expect(() =>
			assertScope(
				["openid", "profile", "offline_access", SCOPES.hqWrite],
				SCOPES.hqWrite,
				"upload_app_to_hq",
			),
		).not.toThrow();
	});

	it("throws McpScopeError carrying scope + tool name when absent", () => {
		try {
			assertScope(
				[SCOPES.read, SCOPES.write],
				SCOPES.hqWrite,
				"upload_app_to_hq",
			);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpScopeError);
			if (!(err instanceof McpScopeError)) return;
			expect(err.requiredScope).toBe(SCOPES.hqWrite);
			expect(err.toolName).toBe("upload_app_to_hq");
			/* The human-readable message names both the tool and the scope
			 * so the MCP client can show the user a precise re-auth prompt
			 * without inferring which tool failed from the JSON-RPC method
			 * line. */
			expect(err.message).toContain("upload_app_to_hq");
			expect(err.message).toContain(SCOPES.hqWrite);
		}
	});

	it("throws when scopes is empty", () => {
		/* The empty-scopes path matters because `parseScopes(undefined)`
		 * returns `[]` — a malformed token that survived signature
		 * verification still gets a clean throw rather than accidentally
		 * proceeding. */
		expect(() => assertScope([], SCOPES.hqRead, "get_hq_connection")).toThrow(
			McpScopeError,
		);
	});
});
