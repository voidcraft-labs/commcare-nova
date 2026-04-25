/**
 * User-facing disclosure helpers for OAuth client identity.
 *
 * Dynamic client registration means `client_name` is client-controlled.
 * Consent UI therefore treats the name as a label, not an identity proof,
 * and pairs it with redirect/publisher context the signed OAuth request
 * already carries.
 */

const RESERVED_BRAND_PATTERN = /\b(nova|commcare|dimagi)\b/i;

export interface OAuthClientDisclosureInput {
	clientName: string;
	redirectUri?: string;
	clientUri?: string;
	trusted: boolean;
}

export interface OAuthClientDisclosure {
	clientName: string;
	trustLabel: "Verified application" | "Unverified application";
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

export function deriveOAuthClientDisclosure(
	input: OAuthClientDisclosureInput,
): OAuthClientDisclosure {
	const brandWarning =
		!input.trusted && RESERVED_BRAND_PATTERN.test(input.clientName);
	return {
		clientName: input.clientName,
		trustLabel: input.trusted
			? "Verified application"
			: "Unverified application",
		redirectDisplay: hostOrScheme(input.redirectUri),
		clientUriDisplay: input.clientUri ? hostOrScheme(input.clientUri) : null,
		brandWarning,
	};
}
