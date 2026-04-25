import { describe, expect, it } from "vitest";
import {
	NOVA_OAUTH_ALLOWED_CLIENT_SCOPES,
	NOVA_OAUTH_DEFAULT_CLIENT_SCOPES,
} from "../auth";

describe("OAuth dynamic client registration scope policy", () => {
	it("defaults anonymous clients to Nova baseline scopes only", () => {
		expect(NOVA_OAUTH_DEFAULT_CLIENT_SCOPES).toEqual([
			"openid",
			"profile",
			"email",
			"offline_access",
			"nova.read",
			"nova.write",
		]);
		expect(NOVA_OAUTH_DEFAULT_CLIENT_SCOPES).not.toContain("nova.hq.read");
		expect(NOVA_OAUTH_DEFAULT_CLIENT_SCOPES).not.toContain("nova.hq.write");
	});

	it("allows baseline scopes plus explicit HQ scopes during registration", () => {
		expect(NOVA_OAUTH_ALLOWED_CLIENT_SCOPES).toEqual([
			"openid",
			"profile",
			"email",
			"offline_access",
			"nova.read",
			"nova.write",
			"nova.hq.read",
			"nova.hq.write",
		]);
	});
});
