/**
 * CommCare HQ server catalog — the closed set of Dimagi SaaS deployments a
 * Nova user can connect to.
 *
 * Each entry is a fully separate CommCare HQ deployment with its own user
 * database: an account (and its API keys) exists on exactly one server, and
 * a key is a bare HMAC digest with no server prefix, so nothing about a key
 * reveals which server issued it. The connection must therefore carry the
 * server explicitly — it is chosen at connect time, stored with the
 * credentials, and every HQ API call derives its base URL from it.
 *
 * The set mirrors CommCare HQ's own registry
 * (`commcare-hq/corehq/apps/hqwebapp/models.py::ServerLocation`): the ids are
 * HQ's environment names, the hosts its subdomains. This closed literal union
 * is also the SSRF boundary for every outbound HQ request — a user picks a
 * member of this record, never a URL, so Nova's server can't be pointed at
 * internal services. Adding an entry here is the only way to widen it.
 *
 * Client-safe: pure data, importable from client components (the settings
 * UI renders the selector from it) and from the server-only HQ client alike.
 */

export const COMMCARE_SERVER_IDS = ["production", "india", "eu"] as const;

/** One of CommCare HQ's SaaS environments, by HQ's own environment name. */
export type CommCareServer = (typeof COMMCARE_SERVER_IDS)[number];

export interface CommCareServerInfo {
	/** Short human label for pickers and error messages ("US", "India", "EU"). */
	readonly label: string;
	/** The deployment's hostname — also what users recognize from their browser. */
	readonly host: string;
	/** Base URL every HQ API call for this server starts from. */
	readonly baseUrl: string;
}

export const COMMCARE_SERVERS: Record<CommCareServer, CommCareServerInfo> = {
	production: {
		label: "US",
		host: "www.commcarehq.org",
		baseUrl: "https://www.commcarehq.org",
	},
	india: {
		label: "India",
		host: "india.commcarehq.org",
		baseUrl: "https://india.commcarehq.org",
	},
	eu: {
		label: "EU",
		host: "eu.commcarehq.org",
		baseUrl: "https://eu.commcarehq.org",
	},
};

/** Narrow an untrusted string (Server Action arg, stored row) to the union. */
export function isCommCareServer(value: string): value is CommCareServer {
	return (COMMCARE_SERVER_IDS as readonly string[]).includes(value);
}
