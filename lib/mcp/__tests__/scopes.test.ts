/**
 * parseScopes + requireScope + SCOPES unit tests.
 *
 * `parseScopes` properties:
 *   - Multi-token claims split on whitespace into ordered arrays.
 *   - Missing `scope` claims produce `[]`, never `undefined` or
 *     `[""]` (both of which would break the caller's `.includes` check).
 *   - Whitespace-only claims produce `[]`, matching the "missing" case.
 *
 * `requireScope` properties:
 *   - Granted scope returns `null` (caller proceeds).
 *   - Missing scope returns a structured `scope_missing` envelope with
 *     the required scope echoed back so an MCP client can build a
 *     precise re-auth prompt without parsing the message.
 *   - The envelope's wire shape (`isError: true`, JSON in
 *     `content[0].text`) matches sibling gate-rejection envelopes.
 */

import { describe, expect, it } from "vitest";
import { parseScopes, requireScope, SCOPES } from "../scopes";

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

describe("requireScope", () => {
	it("returns null when the required scope is granted", () => {
		expect(
			requireScope(
				[SCOPES.read, SCOPES.write, SCOPES.hqRead],
				SCOPES.hqRead,
				"get_hq_connection",
			),
		).toBeNull();
	});

	it("ignores third-party scopes alongside the required one", () => {
		/* OIDC + refresh-token scopes ride alongside Nova scopes on every
		 * token. `requireScope`'s `.includes` check must look at the full
		 * array, not a Nova-only filtered view. */
		expect(
			requireScope(
				["openid", "profile", "offline_access", SCOPES.hqWrite],
				SCOPES.hqWrite,
				"upload_app_to_hq",
			),
		).toBeNull();
	});

	it("returns a scope_missing envelope when the required scope is absent", () => {
		const result = requireScope(
			[SCOPES.read, SCOPES.write],
			SCOPES.hqWrite,
			"upload_app_to_hq",
		);
		expect(result).not.toBeNull();
		if (result === null) return;

		expect(result.isError).toBe(true);
		expect(result.content).toHaveLength(1);
		const text = result.content[0]?.text ?? "";
		const payload = JSON.parse(text) as {
			error_type: string;
			required_scope: string;
			message: string;
		};
		expect(payload.error_type).toBe("scope_missing");
		expect(payload.required_scope).toBe(SCOPES.hqWrite);
		/* The human-readable message names the tool so the MCP client
		 * can show the user a precise re-auth prompt without inferring
		 * which tool failed from the JSON-RPC method line. */
		expect(payload.message).toContain("upload_app_to_hq");
		expect(payload.message).toContain(SCOPES.hqWrite);
	});

	it("rejects when scopes is empty", () => {
		/* The empty-scopes path matters because `parseScopes(undefined)`
		 * returns `[]` — a malformed token that survived signature
		 * verification still gets a clean rejection envelope rather than
		 * accidentally proceeding. */
		const result = requireScope([], SCOPES.hqRead, "get_hq_connection");
		expect(result?.isError).toBe(true);
	});

	it("threads app_id into the envelope when provided", () => {
		/* Every upload-tool failure envelope carries `app_id` — scope
		 * failures must too, or a client switching on `error_type` has
		 * to special-case the missing field. */
		const result = requireScope([], SCOPES.hqWrite, "upload_app_to_hq", "a1");
		const payload = JSON.parse(result?.content[0]?.text ?? "{}") as {
			app_id?: string;
		};
		expect(payload.app_id).toBe("a1");
	});

	it("omits app_id when the caller has no target app", () => {
		/* Tools without an app-id concept at the gate site (e.g.
		 * `get_hq_connection`) pass nothing for `appId` — the field
		 * must drop out of the payload entirely, not appear as `null`
		 * (a present-but-null sentinel would force every client to
		 * branch on both presence and value). */
		const result = requireScope([], SCOPES.hqRead, "get_hq_connection");
		const text = result?.content[0]?.text ?? "{}";
		const payload = JSON.parse(text) as Record<string, unknown>;
		expect("app_id" in payload).toBe(false);
	});
});
