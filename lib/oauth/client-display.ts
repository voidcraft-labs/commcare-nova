/**
 * User-facing disclosure helpers for OAuth client identity.
 *
 * Dynamic client registration means `client_name` is client-controlled.
 * Consent UI therefore treats the name as a label, not an identity proof,
 * and pairs it with redirect/publisher context the signed OAuth request
 * already carries.
 *
 * A client identified by a Client ID Metadata Document adds one proven fact:
 * the host its document lives on. Nova fetched the document from that address
 * and the document names the same address as its `client_id`, so the host is
 * the publisher's. The name inside the document is still whatever the
 * publisher wrote. The host is shown next to the name for that reason, and
 * only when the database says the client came from a document: a URL-shaped
 * id on a registered client proves nothing.
 */

const RESERVED_BRAND_PATTERN = /\b(nova|commcare|dimagi)\b/i;
const CLAUDE_CODE_SERVER_SUFFIX_PATTERN = /^Claude Code\s*\(([^)]+)\)\s*$/i;
const LOCAL_REDIRECT_HOSTS = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"[::1]",
]);

/** The `clientDiscoveryId` the cimd plugin stores on the clients it owns. */
const CIMD_DISCOVERY_ID = "cimd";

export interface OAuthClientDisclosureInput {
	clientName: string;
	redirectUri?: string;
	clientUri?: string;
	trusted: boolean;
	/** The OAuth `client_id`. A URL for a metadata-document client. */
	clientId?: string;
	/** The client row's `clientDiscoveryId`: how Nova came to know the client. */
	discovery?: string | null;
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
	/** The host a metadata-document client is identified by, else `null`. */
	identityHost: string | null;
	brandWarning: boolean;
}

/**
 * The host that identifies a metadata-document client, or `null` for every
 * other client.
 *
 * The value is the URL parser's own `host`: always the ASCII (punycode) form,
 * so a lookalike written in another script reads as `xn--…` rather than as
 * the name it imitates, and it is never converted back to Unicode. `host`
 * rather than `hostname` so a non-default port, which is part of the
 * identity, stays visible; userinfo is never part of it.
 */
export function deriveClientIdentityHost(
	clientId: string | null | undefined,
	discovery: string | null | undefined,
): string | null {
	if (discovery !== CIMD_DISCOVERY_ID || !clientId) return null;
	try {
		const url = new URL(clientId);
		return url.protocol === "https:" ? url.host : null;
	} catch {
		return null;
	}
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
		identityHost: deriveClientIdentityHost(input.clientId, input.discovery),
		brandWarning,
	};
}
