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
		).toMatchObject({
			clientName: "Claude Code",
			appName: "Claude Code",
			detailValue: null,
			detailDescription: null,
			trustLabel: "Unverified application",
			verificationKind: "local",
			redirectDisplay: "localhost:37461",
			clientUriDisplay: "claude.ai",
			brandWarning: false,
		});
	});

	it("formats Claude Code plugin details as a reported client-name claim", () => {
		expect(
			deriveOAuthClientDisclosure({
				clientName: "Claude Code (plugin:nova:nova)",
				redirectUri: "http://localhost:49802/callback",
				trusted: false,
			}),
		).toMatchObject({
			appName: "Claude Code",
			detailValue: "nova (Plugin)",
			detailDescription: null,
			verificationKind: "local",
			redirectDisplay: "localhost:49802",
			brandWarning: false,
		});
	});

	it("formats regular Claude Code MCP details separately from plugin details", () => {
		expect(
			deriveOAuthClientDisclosure({
				clientName: "Claude Code (mcp)",
				redirectUri: "http://localhost:49802/callback",
				trusted: false,
			}),
		).toMatchObject({
			appName: "Claude Code",
			detailValue: "mcp (MCP)",
			detailDescription: null,
			brandWarning: false,
		});
	});

	it("does not interpret parenthetical labels for non-Claude-Code clients", () => {
		expect(
			deriveOAuthClientDisclosure({
				clientName: "Other Client (plugin:acme:server)",
				redirectUri: "http://localhost:49802/callback",
				trusted: false,
			}),
		).toMatchObject({
			appName: "Other Client (plugin:acme:server)",
			detailValue: null,
			detailDescription: null,
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
		expect(disclosure.verificationKind).toBe("remote");
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
		expect(disclosure.verificationKind).toBe("verified");
		expect(disclosure.brandWarning).toBe(false);
	});
});
