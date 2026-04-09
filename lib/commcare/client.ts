/**
 * CommCare HQ REST API client — server-side only.
 *
 * Handles authenticated requests to CommCare HQ for listing project spaces
 * and importing apps. All calls go through our API routes (never from the
 * client browser) so the user's API key stays server-side.
 *
 * Error handling: the client returns `{ success: false, status }` on failure.
 * It does NOT compose user-facing messages — callers know their own context
 * and decide what to show. The raw response body is logged server-side for
 * debugging only.
 *
 * API reference (from dimagi/commcare-hq#37559):
 *   - User domains: GET  /api/user_domains/v1/
 *   - App import:   POST /a/{domain}/apps/api/import_app/
 *
 * Authentication uses CommCare's API key format:
 *   Authorization: ApiKey {username}:{api_key}
 */

import { log } from "@/lib/log";

// ── Types ──────────────────────────────────────────────────────────

/** A CommCare project space the user has access to. */
export interface CommCareDomain {
	/** URL-safe domain slug (used in API paths). */
	name: string;
	/** Human-readable project name. */
	displayName: string;
}

/** Successful app import result. */
export interface ImportResult {
	success: true;
	/** CommCare HQ application ID for the newly created app. */
	appId: string;
	/** Direct URL to the app in CommCare HQ. */
	appUrl: string;
	/** Optional import warnings (e.g. missing multimedia). */
	warnings: string[];
}

/**
 * Error from a CommCare HQ API call — just the status code.
 * Callers decide what to show the user based on their own context.
 */
export interface CommCareApiError {
	success: false;
	status: number;
}

/** Union result type for import operations. */
export type ImportResponse = ImportResult | CommCareApiError;

/** Raw response shape from CommCare HQ's user_domains endpoint. */
interface UserDomainsResponse {
	meta: {
		limit: number;
		next: string | null;
		offset: number;
		total_count: number;
	};
	objects: Array<{ domain_name: string; project_name: string }>;
}

// ── Client ─────────────────────────────────────────────────────────

/**
 * CommCare HQ base URL — hardcoded server-side.
 *
 * Not user-configurable to prevent SSRF attacks. If the user could set this
 * to an arbitrary URL, they could point our server at internal services
 * (GCP metadata server, localhost, etc.) via the proxy routes.
 *
 * If India HQ or staging support is needed in the future, use an allowlist
 * validated against an env var, not a user-supplied value.
 */
export const COMMCARE_HQ_URL = "https://www.commcarehq.org";

/** Credentials needed to authenticate with CommCare HQ. */
export interface CommCareCredentials {
	username: string;
	apiKey: string;
}

/**
 * Build the Authorization header for CommCare HQ API key auth.
 *
 * Format: `ApiKey {username}:{api_key}` — this is CommCare HQ's custom
 * API key scheme, distinct from Basic or Bearer auth.
 */
function authHeader(creds: CommCareCredentials): string {
	return `ApiKey ${creds.username}:${creds.apiKey}`;
}

/**
 * Log a failed CommCare HQ response for server-side debugging.
 * The body is never returned to callers or shown to users.
 */
async function logAndReturnError(
	context: string,
	res: Response,
): Promise<CommCareApiError> {
	let body = "";
	try {
		body = await res.text();
	} catch {}
	log.error(`[commcare] ${context}`, { status: res.status, body });
	return { success: false, status: res.status };
}

/**
 * List all project spaces (domains) the authenticated user has access to.
 *
 * CommCare HQ's `/api/user_domains/v1/` endpoint correctly scopes results
 * to domains where the user has membership. If the API key is domain-scoped,
 * only that single domain is returned.
 *
 * Paginates automatically if the user has more than 100 domains.
 */
export async function listDomains(
	creds: CommCareCredentials,
): Promise<CommCareDomain[] | CommCareApiError> {
	const domains: CommCareDomain[] = [];
	let url: string | null = `${COMMCARE_HQ_URL}/api/user_domains/v1/?limit=100`;
	/** Safety bound — prevents infinite loops from buggy pagination pointers. */
	const MAX_PAGES = 50;
	let page = 0;

	while (url && page < MAX_PAGES) {
		page++;
		const res = await fetch(url, {
			headers: { Authorization: authHeader(creds) },
		});

		if (!res.ok) {
			return logAndReturnError("listDomains failed", res);
		}

		const data = (await res.json()) as UserDomainsResponse;
		for (const obj of data.objects) {
			domains.push({
				name: obj.domain_name,
				displayName: obj.project_name || obj.domain_name,
			});
		}

		/* CommCare HQ returns relative next URLs — resolve against the base. */
		url = data.meta.next
			? new URL(data.meta.next, COMMCARE_HQ_URL).toString()
			: null;
	}

	return domains;
}

/**
 * Test whether the API key can access a specific domain.
 *
 * Makes a lightweight GET to the list_apps endpoint — returns true on
 * 200, false on 401/403. CommCare HQ returns 401 (not 403) for domains
 * where the API key lacks app-level access, even though the key is valid
 * for the user_domains endpoint. Since callers already validated the key
 * via listDomains(), a per-domain 401 is a scope issue, not invalid creds.
 * Only 5xx errors propagate as CommCareApiError.
 */
export async function testDomainAccess(
	creds: CommCareCredentials,
	domain: string,
): Promise<boolean | CommCareApiError> {
	const url = `${COMMCARE_HQ_URL}/a/${domain}/apps/api/list_apps/`;
	const res = await fetch(url, {
		headers: { Authorization: authHeader(creds) },
	});

	if (res.ok) return true;
	if (res.status === 401 || res.status === 403) return false;
	return logAndReturnError(`testDomainAccess(${domain}) failed`, res);
}

/**
 * Import an app into a CommCare HQ project space.
 *
 * Sends the expanded HQ JSON as a multipart form upload. CommCare HQ
 * creates a brand-new app each time — there is no atomic update API,
 * so each call produces a fresh app in the target domain.
 */
export async function importApp(
	creds: CommCareCredentials,
	domain: string,
	appName: string,
	appJson: object,
): Promise<ImportResponse> {
	const url = `${COMMCARE_HQ_URL}/a/${domain}/apps/api/import_app/`;

	/*
	 * CommCare HQ expects multipart/form-data with:
	 *   - app_name: string field
	 *   - app_file: the JSON file as a blob
	 *
	 * Using the native FormData + Blob API (available in Node 18+) to
	 * construct the multipart request. The Blob gets a filename so
	 * CommCare HQ's file validation recognizes it as a JSON upload.
	 */
	const formData = new FormData();
	formData.append("app_name", appName);
	formData.append(
		"app_file",
		new Blob([JSON.stringify(appJson)], { type: "application/json" }),
		"app.json",
	);

	const res = await fetch(url, {
		method: "POST",
		headers: { Authorization: authHeader(creds) },
		body: formData,
	});

	if (!res.ok) {
		return logAndReturnError("import failed", res);
	}

	const data = (await res.json()) as {
		success: boolean;
		app_id: string;
		warnings?: string[];
	};

	return {
		success: true,
		appId: data.app_id,
		appUrl: `${COMMCARE_HQ_URL}/a/${domain}/apps/view/${data.app_id}/`,
		warnings: data.warnings ?? [],
	};
}
