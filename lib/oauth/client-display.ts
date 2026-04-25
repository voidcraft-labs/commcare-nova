/**
 * User-facing disclosure helpers for OAuth client identity.
 *
 * Dynamic client registration means `client_name` is client-controlled.
 * Consent UI therefore treats the name as a label, not an identity proof,
 * and pairs it with redirect/publisher context the signed OAuth request
 * already carries.
 */

const RESERVED_BRAND_PATTERN = /\b(nova|commcare|dimagi)\b/i;
const CLAUDE_CODE_SERVER_SUFFIX_PATTERN = /^Claude Code\s*\(([^)]+)\)\s*$/i;
const LOCAL_REDIRECT_HOSTS = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"[::1]",
]);

export interface OAuthClientDisclosureInput {
	clientName: string;
	redirectUri?: string;
	clientUri?: string;
	trusted: boolean;
}

export interface OAuthClientDisclosure {
	clientName: string;
	appName: string;
	detailValue: string | null;
	detailDescription: string | null;
	trustLabel: "Verified application" | "Unverified application";
	verificationKind: "verified" | "local" | "remote";
	verificationLabel:
		| "Verified app"
		| "Unverified local app"
		| "Unverified remote app";
	redirectDisplay: string;
	clientUriDisplay: string | null;
	brandWarning: boolean;
}

function hostOrScheme(raw: string | undefined): string {
	if (!raw) return "Unknown destination";
	try {
		const url = new URL(raw);
		if (url.protocol === "http:" || url.protocol === "https:") {
			return url.host;
		}
		return `${url.protocol.replace(/:$/, "")}://`;
	} catch {
		return "Unknown destination";
	}
}

function isLocalRedirect(raw: string | undefined): boolean {
	if (!raw) return false;
	try {
		const url = new URL(raw);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			LOCAL_REDIRECT_HOSTS.has(url.hostname)
		);
	} catch {
		return false;
	}
}

function splitClientName(clientName: string): {
	appName: string;
	detailValue: string | null;
	detailDescription: string | null;
} {
	const match = clientName.match(CLAUDE_CODE_SERVER_SUFFIX_PATTERN);
	if (!match) {
		return { appName: clientName, detailValue: null, detailDescription: null };
	}

	const rawServerName = match[1]?.trim();
	if (!rawServerName) {
		return { appName: clientName, detailValue: null, detailDescription: null };
	}

	if (rawServerName.startsWith("plugin:")) {
		const parts = rawServerName.split(":");
		const pluginName = parts[1]?.trim();
		const serverName = parts.slice(2).join(":").trim();
		return {
			appName: "Claude Code",
			detailValue: `${serverName || pluginName || rawServerName} (Plugin)`,
			detailDescription: null,
		};
	}

	return {
		appName: "Claude Code",
		detailValue: `${rawServerName} (MCP)`,
		detailDescription: null,
	};
}

export function deriveOAuthClientDisclosure(
	input: OAuthClientDisclosureInput,
): OAuthClientDisclosure {
	const { appName, detailValue, detailDescription } = splitClientName(
		input.clientName,
	);
	const localRedirect = isLocalRedirect(input.redirectUri);
	const brandWarning = !input.trusted && RESERVED_BRAND_PATTERN.test(appName);
	const verificationLabel = input.trusted
		? "Verified app"
		: localRedirect
			? "Unverified local app"
			: "Unverified remote app";
	const verificationKind = input.trusted
		? "verified"
		: localRedirect
			? "local"
			: "remote";
	return {
		clientName: input.clientName,
		appName,
		detailValue,
		detailDescription,
		trustLabel: input.trusted
			? "Verified application"
			: "Unverified application",
		verificationKind,
		verificationLabel,
		redirectDisplay: hostOrScheme(input.redirectUri),
		clientUriDisplay: input.clientUri ? hostOrScheme(input.clientUri) : null,
		brandWarning,
	};
}
