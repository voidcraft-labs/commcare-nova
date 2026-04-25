import { describe, expect, it } from "vitest";
import { deriveOAuthClientDisclosure } from "../client-display";

describe("deriveOAuthClientDisclosure", () => {
	it("marks dynamic clients as unverified and exposes the redirect origin", () => {
		expect(
			deriveOAuthClientDisclosure({
				clientName: "Claude Code",
				redirectUri: "http://localhost:37461/callback?state=abc",
				clientUri: "https://claude.ai",
				trusted: false,
			}),
		).toEqual({
			clientName: "Claude Code",
			trustLabel: "Unverified application",
			redirectDisplay: "localhost:37461",
			clientUriDisplay: "claude.ai",
			brandWarning: false,
		});
	});

	it("flags untrusted clients with Nova/CommCare/Dimagi-like names", () => {
		const disclosure = deriveOAuthClientDisclosure({
			clientName: "CommCare Nova",
			redirectUri: "https://example.test/oauth/callback",
			trusted: false,
		});

		expect(disclosure.trustLabel).toBe("Unverified application");
		expect(disclosure.redirectDisplay).toBe("example.test");
		expect(disclosure.brandWarning).toBe(true);
	});

	it("does not flag reserved brand names for trusted clients", () => {
		const disclosure = deriveOAuthClientDisclosure({
			clientName: "CommCare Nova",
			redirectUri: "https://commcare.app/oauth/callback",
			trusted: true,
		});

		expect(disclosure.trustLabel).toBe("Verified application");
		expect(disclosure.brandWarning).toBe(false);
	});
});
