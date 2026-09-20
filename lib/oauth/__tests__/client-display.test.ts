import { describe, expect, it } from "vitest";
import {
	deriveClientIdentityHost,
	deriveOAuthClientDisclosure,
} from "../client-display";

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
				clientName: "Claude Code (plugin:publisher:nova)",
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

	it.each(["Nova", "COMMCARE", "dimagi"])(
		"flags an untrusted client using the %s brand",
		(clientName) => {
			const disclosure = deriveOAuthClientDisclosure({
				clientName,
				redirectUri: "https://example.test/oauth/callback",
				trusted: false,
			});

			expect(disclosure.trustLabel).toBe("Unverified application");
			expect(disclosure.verificationKind).toBe("remote");
			expect(disclosure.redirectDisplay).toBe("example.test");
			expect(disclosure.brandWarning).toBe(true);
		},
	);

	it.each([
		["http://127.0.0.1:456/callback", "local", "127.0.0.1:456"],
		["http://[::1]:456/callback", "local", "[::1]:456"],
		[
			"https://localhost.attacker.test/callback",
			"remote",
			"localhost.attacker.test",
		],
		["https://localhost@remote.test/callback", "remote", "remote.test"],
		["custom-app://localhost/callback", "remote", "custom-app://"],
		["invalid uri", "remote", "Unknown destination"],
	] as const)(
		"classifies %s by its actual destination",
		(redirectUri, verificationKind, redirectDisplay) => {
			expect(
				deriveOAuthClientDisclosure({
					clientName: "Client",
					redirectUri,
					trusted: false,
				}),
			).toMatchObject({
				verificationKind,
				redirectDisplay,
				trustLabel: "Unverified application",
			});
		},
	);

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

describe("deriveClientIdentityHost", () => {
	it("shows a lookalike host in its ASCII form, never as the name it imitates", () => {
		/* The first letter is CYRILLIC SMALL LETTER A (U+0430), not Latin "a". */
		const host = deriveClientIdentityHost(
			"https://аpple.com/client.json",
			"cimd",
		);
		expect(host).toBe("xn--pple-43d.com");
		expect(host).not.toBe("apple.com");
		expect(host).not.toContain("а");
	});

	it.each([
		[
			"keeps every label of a host that starts like a trusted one",
			"https://claude.ai.evil.example/c.json",
			"claude.ai.evil.example",
		],
		[
			"keeps a trailing dot as the URL wrote it",
			"https://claude.ai./c.json",
			"claude.ai.",
		],
		[
			"shows a port that isn't the default",
			"https://claude.ai:8443/c.json",
			"claude.ai:8443",
		],
		["drops the default port", "https://claude.ai:443/c.json", "claude.ai"],
		[
			"never shows userinfo",
			"https://claude.ai:secret@evil.example/c.json",
			"evil.example",
		],
		["lowercases the host", "https://CLAUDE.AI/c.json", "claude.ai"],
	])("%s", (_name, clientId, expected) => {
		expect(deriveClientIdentityHost(clientId, "cimd")).toBe(expected);
	});

	it.each([
		["an http id", "http://claude.ai/c.json", "cimd"],
		["an id that isn't a URL", "abc123", "cimd"],
		["an empty id", "", "cimd"],
		["a missing id", undefined, "cimd"],
		["a URL-shaped id on a registered client", "https://claude.ai/c", null],
		["a URL-shaped id with an empty discovery", "https://claude.ai/c", ""],
		["a URL-shaped id with no discovery", "https://claude.ai/c", undefined],
		["a URL-shaped id from another discovery", "https://claude.ai/c", "other"],
	])("has no identifying host for %s", (_name, clientId, discovery) => {
		expect(deriveClientIdentityHost(clientId, discovery)).toBeNull();
	});
});

describe("deriveOAuthClientDisclosure: identifying host", () => {
	const claudeCode = {
		clientName: "Claude Code",
		redirectUri: "http://localhost:3118/callback",
		clientUri: "https://claude.ai",
		trusted: false,
	};

	it("adds the host for a metadata-document client and changes nothing else", () => {
		const registered = deriveOAuthClientDisclosure(claudeCode);
		const discovered = deriveOAuthClientDisclosure({
			...claudeCode,
			clientId: "https://claude.ai/oauth/claude-code-client-metadata",
			discovery: "cimd",
		});

		expect(registered.identityHost).toBeNull();
		expect(discovered).toEqual({ ...registered, identityHost: "claude.ai" });
		/* A proven host is not a verified app: the redirect is still local. */
		expect(discovered.verificationLabel).toBe("Unverified local app");
	});

	it("takes provenance from the database, not the shape of the id", () => {
		expect(
			deriveOAuthClientDisclosure({
				...claudeCode,
				clientId: "https://claude.ai/oauth/claude-code-client-metadata",
				discovery: null,
			}).identityHost,
		).toBeNull();
	});
});
