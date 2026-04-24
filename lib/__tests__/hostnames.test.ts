import { describe, expect, it } from "vitest";
import {
	AS_ISSUER,
	classifyHost,
	HOSTNAMES,
	isPathAllowedOnHost,
	MCP_RESOURCE_URL,
	normalizeHost,
} from "../hostnames";

describe("normalizeHost", () => {
	it("lowercases", () => {
		expect(normalizeHost("CommCare.App")).toBe("commcare.app");
	});
	it("strips trailing dot", () => {
		expect(normalizeHost("mcp.commcare.app.")).toBe("mcp.commcare.app");
	});
	it("strips :443 and :80", () => {
		expect(normalizeHost("commcare.app:443")).toBe("commcare.app");
		expect(normalizeHost("commcare.app:80")).toBe("commcare.app");
	});
	it("keeps non-standard ports (dev)", () => {
		expect(normalizeHost("localhost:3000")).toBe("localhost:3000");
	});
	it("returns empty string for null", () => {
		expect(normalizeHost(null)).toBe("");
	});
	it("trims whitespace", () => {
		expect(normalizeHost("  commcare.app  ")).toBe("commcare.app");
	});
});

describe("classifyHost", () => {
	it("classifies known hostnames", () => {
		expect(classifyHost("commcare.app")).toBe(HOSTNAMES.main);
		expect(classifyHost("mcp.commcare.app")).toBe(HOSTNAMES.mcp);
		expect(classifyHost("docs.commcare.app")).toBe(HOSTNAMES.docs);
	});
	it("returns null for unknown hostnames", () => {
		expect(classifyHost("foo-uc.a.run.app")).toBeNull();
		expect(classifyHost("localhost:3000")).toBeNull();
	});
	it("returns null for empty string (missing Host header)", () => {
		expect(classifyHost("")).toBeNull();
	});
});

describe("isPathAllowedOnHost", () => {
	it("allows MCP paths only on mcp.commcare.app", () => {
		expect(isPathAllowedOnHost(HOSTNAMES.mcp, "/mcp")).toBe(true);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/mcp")).toBe(false);
	});
	it("blocks /admin on mcp.commcare.app", () => {
		expect(isPathAllowedOnHost(HOSTNAMES.mcp, "/admin")).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/admin")).toBe(true);
	});
	it("allows OAuth-AS metadata on commcare.app but not on mcp", () => {
		expect(
			isPathAllowedOnHost(
				HOSTNAMES.main,
				"/.well-known/oauth-authorization-server",
			),
		).toBe(true);
		expect(
			isPathAllowedOnHost(
				HOSTNAMES.mcp,
				"/.well-known/oauth-authorization-server",
			),
		).toBe(false);
	});
	it("allows resource metadata on mcp but not on main", () => {
		expect(
			isPathAllowedOnHost(
				HOSTNAMES.mcp,
				"/.well-known/oauth-protected-resource",
			),
		).toBe(true);
		expect(
			isPathAllowedOnHost(
				HOSTNAMES.main,
				"/.well-known/oauth-protected-resource",
			),
		).toBe(false);
	});
	it("does not match across path-segment boundary", () => {
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/admins")).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/api/authority")).toBe(false);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/buildings")).toBe(false);
	});
	it("matches exact prefix and deeper subpaths", () => {
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/admin")).toBe(true);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/admin/users")).toBe(true);
		expect(isPathAllowedOnHost(HOSTNAMES.main, "/api/auth/callback")).toBe(
			true,
		);
	});
});

describe("OAuth resource identifiers", () => {
	it("uses the externally reachable MCP endpoint URL as the protected resource", () => {
		expect(MCP_RESOURCE_URL).toBe("https://mcp.commcare.app/mcp");
	});

	it("uses Better Auth's /api/auth base path as the token issuer", () => {
		expect(AS_ISSUER).toBe("https://commcare.app/api/auth");
	});
});
