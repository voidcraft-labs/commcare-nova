import { describe, expect, it } from "vitest";
import {
	AUTHORIZE_ISSUE_REASONS,
	classifyAuthorizeResponse,
	connectionIssueUrl,
	parseAuthorizeIssueReason,
} from "../authorize-errors";

const ORIGIN = "https://commcare.app";

/** An authorize request URL for `clientId`, shaped like an MCP client's. */
function authorizeUrl(clientId: string): string {
	const url = new URL("/api/auth/oauth2/authorize", ORIGIN);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: "http://localhost:3118/callback",
		state: "x",
	}).toString();
	return url.toString();
}

const OPAQUE = authorizeUrl("does-not-exist");
const METADATA_URL = authorizeUrl("https://app.example.test/oauth/client.json");

/** Better Auth's `errorURL` redirect, exactly as it serves it: relative. */
function errorRedirect(code: string): string {
	return `/?${new URLSearchParams({
		error: code,
		error_description: "client_id is required",
	})}`;
}

describe("classifyAuthorizeResponse: errorURL redirects", () => {
	it("reads invalid_client on an opaque id as a client Nova no longer knows", () => {
		expect(
			classifyAuthorizeResponse({
				status: 302,
				location: errorRedirect("invalid_client"),
				requestUrl: OPAQUE,
			}),
		).toBe("unknown-client");
	});

	it("reads invalid_client on an https id as an address Nova couldn't read", () => {
		expect(
			classifyAuthorizeResponse({
				status: 302,
				location: errorRedirect("invalid_client"),
				requestUrl: METADATA_URL,
			}),
		).toBe("client-unavailable");
	});

	it("accepts the same redirect written as an absolute same-origin URL", () => {
		expect(
			classifyAuthorizeResponse({
				status: 302,
				location: `${ORIGIN}${errorRedirect("invalid_client")}`,
				requestUrl: OPAQUE,
			}),
		).toBe("unknown-client");
	});

	it("reads temporarily_unavailable as a wait", () => {
		expect(
			classifyAuthorizeResponse({
				status: 302,
				location: errorRedirect("temporarily_unavailable"),
				requestUrl: OPAQUE,
			}),
		).toBe("try-again-shortly");
	});

	it.each([
		"client_disabled",
		"unauthorized_client",
		"invalid_redirect",
		"unsupported_response_type",
		"invalid_request",
		"a_code_nobody_has_seen",
	])("reads %s as the generic request problem", (code) => {
		expect(
			classifyAuthorizeResponse({
				status: 302,
				location: errorRedirect(code),
				requestUrl: OPAQUE,
			}),
		).toBe("request-problem");
	});
});

describe("classifyAuthorizeResponse: redirects it must leave alone", () => {
	it.each([
		["the sign-in redirect to / without an error", "/"],
		["the sign-in redirect carrying the signed query", "/?client_id=abc&sig=s"],
		["the consent redirect", "/consent?client_id=abc&scope=openid&sig=s"],
		["an error param on a path other than /", "/consent?error=invalid_client"],
		[
			"an error delivered to the client's loopback redirect_uri",
			"http://localhost:3118/callback?error=access_denied",
		],
		[
			"an error delivered to / on another origin",
			"https://client.example.test/?error=invalid_client",
		],
	])("%s", (_name, location) => {
		expect(
			classifyAuthorizeResponse({
				status: 302,
				location,
				requestUrl: OPAQUE,
			}),
		).toBeNull();
	});

	it("a redirect with no Location header", () => {
		expect(
			classifyAuthorizeResponse({
				status: 302,
				location: null,
				requestUrl: OPAQUE,
			}),
		).toBeNull();
	});
});

describe("classifyAuthorizeResponse: direct error responses", () => {
	it("reads a JSON 400 invalid_client by the id's shape", () => {
		const body = {
			error: "invalid_client",
			error_description: "metadata document could not be fetched",
		};
		expect(
			classifyAuthorizeResponse({
				status: 400,
				location: null,
				requestUrl: METADATA_URL,
				body,
			}),
		).toBe("client-unavailable");
		expect(
			classifyAuthorizeResponse({
				status: 400,
				location: null,
				requestUrl: OPAQUE,
				body,
			}),
		).toBe("unknown-client");
	});

	it("reads any 429 as a wait, with or without a body", () => {
		expect(
			classifyAuthorizeResponse({
				status: 429,
				location: null,
				requestUrl: METADATA_URL,
			}),
		).toBe("try-again-shortly");
		expect(
			classifyAuthorizeResponse({
				status: 429,
				location: null,
				requestUrl: METADATA_URL,
				body: { error: "invalid_client" },
			}),
		).toBe("try-again-shortly");
	});

	it.each([
		["no body", undefined],
		["a body with no error code", { message: "nope" }],
		["a non-string error code", { error: 42 }],
		["a body that isn't an object", "invalid_client"],
	])("leaves a 4xx with %s untouched", (_name, body) => {
		expect(
			classifyAuthorizeResponse({
				status: 400,
				location: null,
				requestUrl: OPAQUE,
				body,
			}),
		).toBeNull();
	});

	it.each([200, 204, 500, 503])("leaves a %i untouched", (status) => {
		expect(
			classifyAuthorizeResponse({
				status,
				location: null,
				requestUrl: OPAQUE,
				body: { error: "invalid_client" },
			}),
		).toBeNull();
	});
});

describe("parseAuthorizeIssueReason", () => {
	it("round-trips every reason", () => {
		for (const reason of AUTHORIZE_ISSUE_REASONS) {
			expect(parseAuthorizeIssueReason(reason)).toBe(reason);
		}
	});

	it.each([
		null,
		undefined,
		"",
		"invalid_client",
		"Unknown-Client",
		"unknown-client ",
		"<script>alert(1)</script>",
		"toString",
	])("falls back to the generic reason for %j", (raw) => {
		expect(parseAuthorizeIssueReason(raw)).toBe("request-problem");
	});
});

describe("connectionIssueUrl", () => {
	it("carries the reason and nothing the provider or requester wrote", () => {
		const reason = classifyAuthorizeResponse({
			status: 302,
			location: errorRedirect("invalid_client"),
			requestUrl: OPAQUE,
		});
		if (reason === null) throw new Error("Expected a classified reason");
		const destination = new URL(connectionIssueUrl(reason), ORIGIN);
		expect(destination.pathname).toBe("/connection-issue");
		expect([...destination.searchParams.keys()]).toEqual(["reason"]);
		expect(destination.searchParams.get("reason")).toBe("unknown-client");
		expect(destination.href).not.toContain("client_id");
		expect(destination.href).not.toContain("required");
		expect(destination.href).not.toContain("invalid_client");
	});
});
