/**
 * parseScopes unit tests.
 *
 * Three properties matter for the downstream verify layer:
 *   - Multi-token claims split on whitespace into ordered arrays.
 *   - Missing `scope` claims produce `[]`, never `undefined` or
 *     `[""]` (both of which would break the caller's `.includes` check).
 *   - Whitespace-only claims produce `[]`, matching the "missing" case.
 */

import { describe, expect, it } from "vitest";
import { parseScopes, SCOPES } from "../scopes";

describe("parseScopes", () => {
	it("splits a space-separated scope claim into tokens in order", () => {
		expect(
			parseScopes({ sub: "u", scope: "nova.read nova.write openid" }),
		).toEqual(["nova.read", "nova.write", "openid"]);
	});

	it("returns [] when the scope claim is absent", () => {
		expect(parseScopes({ sub: "u" })).toEqual([]);
	});

	it("returns [] when the scope claim is whitespace-only", () => {
		expect(parseScopes({ sub: "u", scope: "   " })).toEqual([]);
	});

	it("collapses runs of internal whitespace without emitting empty tokens", () => {
		/* Defensive: some token servers emit CRLF-separated scopes or
		 * accidentally double-space them. The split regex handles any
		 * whitespace run, and `filter(Boolean)` drops the empty strings
		 * that leading/trailing whitespace would otherwise produce. */
		expect(
			parseScopes({ sub: "u", scope: "  nova.read\t nova.write  " }),
		).toEqual(["nova.read", "nova.write"]);
	});
});

describe("SCOPES", () => {
	it("exposes the canonical scope string literals", () => {
		/* Pins the wire values — changing them is a breaking change for
		 * every issued access token, so this test is a tripwire that
		 * forces anyone renaming to acknowledge the impact. */
		expect(SCOPES.read).toBe("nova.read");
		expect(SCOPES.write).toBe("nova.write");
	});
});
