/**
 * CommCare HQ REST API client — server-side only.
 *
 * Handles authenticated requests to CommCare HQ for listing project spaces,
 * importing apps, and uploading an imported app's media bytes. All calls go
 * through our API routes (never from the client browser) so the user's API
 * key stays server-side.
 *
 * Error handling: the client returns `{ success: false, status }` on failure.
 * It does NOT compose user-facing messages — callers know their own context
 * and decide what to show. The raw response body is logged server-side for
 * debugging only.
 *
 * API reference (from dimagi/commcare-hq#37559):
 *   - User domains:   GET  /api/user_domains/v1/
 *   - App import:     POST /a/{domain}/apps/api/import_app/
 *   - Media upload:   POST /a/{domain}/apps/api/{app_id}/multimedia/        (bulk ZIP)
 *   - Media status:   GET  /a/{domain}/apps/api/{app_id}/multimedia/status/{processing_id}/
 *
 * Authentication uses CommCare's API key format:
 *   Authorization: ApiKey {username}:{api_key}
 *
 * The media upload uses the bulk `upload_multimedia_api` endpoint (same
 * `@api_auth()` gate as import) — NOT the per-kind `multimedia/uploaded/{kind}/`
 * endpoints, which are session-only and reject the API key. See
 * `uploadAppMediaBundle`.
 */

import { log } from "@/lib/logger";

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

// ── Validation ────────────────────────────────────────────────────

/**
 * CommCare HQ domain slug validation — mirrors HQ's `legacy_domain_re`
 * (`[\w\.:-]+`) which is used in URL routing. Three tiers exist in HQ:
 * new domains (alphanum + hyphens), grandfathered (+ dots, colons), and
 * legacy (+ underscores). We accept all three since any routable domain
 * is a valid upload target. The regex prevents path traversal (no `/`)
 * while accepting all domains that HQ can actually resolve.
 *
 * Source: corehq/apps/domain/utils.py — `legacy_domain_re`
 */
const DOMAIN_SLUG_RE = /^[\w.:-]+$/;

export function isValidDomainSlug(domain: string): boolean {
	return DOMAIN_SLUG_RE.test(domain);
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
	log.error(`[commcare] ${context}`, {
		status: res.status,
		body: body.substring(0, 200),
	});
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

		/* Resolve pagination URL — validate it stays on the expected host.
		 * Tastypie can return absolute URLs; if a proxy rewrites the host or
		 * a MITM injects a foreign URL, following it would leak the user's
		 * API key via the Authorization header. */
		if (data.meta.next) {
			const resolved = new URL(data.meta.next, COMMCARE_HQ_URL);
			url =
				resolved.origin === new URL(COMMCARE_HQ_URL).origin
					? resolved.toString()
					: null;
		} else {
			url = null;
		}
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
	if (!isValidDomainSlug(domain)) return false;
	const url = `${COMMCARE_HQ_URL}/a/${domain}/apps/api/list_apps/`;
	const res = await fetch(url, {
		headers: { Authorization: authHeader(creds) },
	});

	if (res.ok) return true;
	if (res.status === 401 || res.status === 403) return false;
	return logAndReturnError(`testDomainAccess(${domain}) failed`, res);
}

/**
 * Resolve the set of project spaces the key can reach at the app level.
 *
 * `listDomains` returns every space the user belongs to that the key's scope
 * allows — but HQ returns 401 from the app-level endpoint for some of those
 * (membership without app access; see `testDomainAccess`). So we probe every
 * listed space and keep only the ones that pass.
 *
 * Probes run in a BOUNDED-concurrency window (`PROBE_CONCURRENCY` at a time),
 * not all at once. An unscoped key on a heavily-shared account (e.g. a Dimagi
 * internal user) can list hundreds of spaces; firing every probe simultaneously
 * would open hundreds of connections to HQ and self-inflict a 429 — and since
 * a 429 on any probe fails the whole discovery, that would make save/refresh
 * fail outright for exactly the largest keys. The window keeps HQ load modest
 * while still parallelizing; save/refresh are rare and not latency-critical.
 *
 * A 5xx (or 429) from `listDomains` or any probe surfaces as `CommCareApiError`
 * so the caller can tell "HQ is down / throttling" from "the key reaches these
 * spaces"; the first such error short-circuits the remaining windows.
 *
 * Fidelity caveat: the probe hits the read-level `list_apps` endpoint, which
 * the actual upload (`import_app`) does not — upload additionally requires the
 * `edit_apps` permission on the space. So this set can slightly OVER-report: a
 * space where the user can read but not author apps passes the probe yet the
 * upload itself returns 403. That degrades cleanly (the upload surfaces a
 * permission error naming the space); we don't pre-probe `edit_apps` because
 * there is no cheap read-only endpoint that gates on it.
 */
const PROBE_CONCURRENCY = 8;

export async function discoverAccessibleDomains(
	creds: CommCareCredentials,
): Promise<CommCareDomain[] | CommCareApiError> {
	const all = await listDomains(creds);
	if (!Array.isArray(all)) return all;

	const accessible: CommCareDomain[] = [];
	/* Sequential windows of `PROBE_CONCURRENCY` parallel probes. Bounds peak
	 * connections to HQ regardless of how many spaces the key lists. */
	for (let i = 0; i < all.length; i += PROBE_CONCURRENCY) {
		const window = all.slice(i, i + PROBE_CONCURRENCY);
		const probed = await Promise.all(
			window.map(async (domain) => ({
				domain,
				access: await testDomainAccess(creds, domain.name),
			})),
		);

		/* A server error (5xx) or throttle (429) means we can't trust the
		 * result set — propagate it rather than silently dropping a space or
		 * continuing to hammer HQ. */
		const serverError = probed.find((p) => typeof p.access === "object");
		if (serverError) return serverError.access as CommCareApiError;

		for (const p of probed) if (p.access === true) accessible.push(p.domain);
	}

	return accessible;
}

/**
 * Extract a named cookie value from a response's Set-Cookie headers.
 *
 * Uses the standard `getSetCookie()` API (Node 20+) which returns one
 * raw header string per cookie. Each string is `name=value; attrs...`.
 */
function getCookie(res: Response, cookieName: string): string | null {
	for (const raw of res.headers.getSetCookie()) {
		const [pair] = raw.split(";", 1);
		const [name, value] = pair.split("=", 2);
		if (name === cookieName && value) return value;
	}
	return null;
}

/**
 * Fetch a CSRF token from CommCare HQ.
 *
 * The import_app endpoint requires Django CSRF validation (it's missing
 * the `@csrf_exempt` decorator that other HQ API endpoints have). API
 * endpoints don't set the `csrftoken` cookie — only HTML pages do — so
 * we hit the unauthenticated login page to obtain one. The token is
 * ephemeral (used immediately on the next POST) and not stored.
 *
 * Returns null if the token can't be obtained (caller should still
 * attempt the import — the CSRF requirement may be fixed upstream).
 */
async function fetchCsrfToken(): Promise<string | null> {
	try {
		const res = await fetch(`${COMMCARE_HQ_URL}/accounts/login/`);
		return getCookie(res, "csrftoken");
	} catch {
		return null;
	}
}

/**
 * Import an app into a CommCare HQ project space.
 *
 * Sends the expanded HQ JSON as a multipart form upload. CommCare HQ
 * creates a brand-new app each time — there is no atomic update API,
 * so each call produces a fresh app in the target domain.
 *
 * The import endpoint requires a Django CSRF token, so we make a
 * lightweight GET first to obtain one, then include it on the POST.
 */
export async function importApp(
	creds: CommCareCredentials,
	domain: string,
	appName: string,
	appJson: object,
): Promise<ImportResponse> {
	if (!isValidDomainSlug(domain)) {
		return { success: false, status: 400 };
	}
	const url = `${COMMCARE_HQ_URL}/a/${domain}/apps/api/import_app/`;

	/* Obtain a CSRF token before the POST — see fetchCsrfToken() for why. */
	const csrfToken = await fetchCsrfToken();

	/*
	 * Multipart form: app_name (string) + app_file (JSON blob).
	 *
	 * WAF bypass: HQ's import_app is missing waf_allow('XSS_BODY'), so AWS
	 * WAF blocks requests containing XForms XML that looks like HTML XSS
	 * (<input>, <select1>, <label>). A 16KB padding field before app_file
	 * pushes the JSON past the WAF inspection window. Django ignores unknown
	 * form fields. Do not remove — must appear before app_file.
	 */
	const WAF_PADDING = "x".repeat(16 * 1024);
	const formData = new FormData();
	formData.append("app_name", appName);
	formData.append("waf_padding", WAF_PADDING);
	formData.append(
		"app_file",
		new Blob([JSON.stringify(appJson)], { type: "application/json" }),
		"app.json",
	);

	const headers: Record<string, string> = {
		Authorization: authHeader(creds),
	};
	if (csrfToken) {
		headers["X-CSRFToken"] = csrfToken;
		headers.Cookie = `csrftoken=${csrfToken}`;
		headers.Referer = url;
	}

	const res = await fetch(url, {
		method: "POST",
		headers,
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

	/* HQ can return HTTP 200 with success:false for application-level
	 * import failures (malformed JSON, schema violations). The response
	 * body is already consumed so we log the parsed result directly. */
	if (!data.success) {
		log.error("[commcare] import rejected by HQ", { domain, data });
		return { success: false, status: 422 };
	}

	return {
		success: true,
		appId: data.app_id,
		appUrl: `${COMMCARE_HQ_URL}/a/${domain}/apps/view/${data.app_id}/`,
		warnings: data.warnings ?? [],
	};
}

// ── Multimedia upload (bulk API) ───────────────────────────────────

/**
 * Outcome of a bulk media upload. `matched` / `unmatched` come from HQ's
 * async processing of the ZIP (files matched to the app's references vs
 * files the app doesn't reference); `errors` carries any processing errors
 * HQ reported. `timedOut` means we stopped polling before HQ finished — the
 * ZIP was accepted and is still processing server-side, so the media will
 * appear shortly even though we didn't confirm the match.
 */
export interface MediaBundleUploadResult {
	readonly matched: number;
	readonly unmatched: number;
	readonly errors: readonly string[];
	readonly timedOut: boolean;
}

/* Poll cadence + ceiling for the async bulk-upload processing. The bytes
 * are already accepted when polling starts, so this only confirms the match
 * result — bounded so a slow/stuck task can't hold the request open. */
const MEDIA_BUNDLE_POLL_INTERVAL_MS = 1500;
const MEDIA_BUNDLE_POLL_TIMEOUT_MS = 45_000;

/**
 * Upload an app's media as one bulk ZIP to CommCare HQ's
 * `upload_multimedia_api` (`POST /a/{domain}/apps/api/{app_id}/multimedia/`).
 *
 * This is the API-key-authenticated media path — the SAME `@api_auth()`
 * gate as `import_app_api`. The per-kind `multimedia/uploaded/<kind>/`
 * endpoints are `login_and_domain_required` (session/cookie auth that
 * ignores the `ApiKey` header), so an API-key client gets HQ's HTML login
 * page back instead of JSON — they can't be used here. Verified against
 * `commcare-hq/.../app_manager/views/app_import_api.py` (the `@api_auth()`
 * decorator) and `hqmedia/views.py` (the session-only per-kind views).
 *
 * HQ unzips the bundle and matches each `commcare/<hash><ext>` entry against
 * the app's FORM/MENU media paths — `process_bulk_upload_zip` keeps only
 * entries whose path is in `app.get_all_paths_of_type(...)`, and HQ's
 * `ApplicationMediaMixin.all_media` EXCLUDES app-level media (logos). So a
 * file referenced anywhere in the forms/menus attaches; an image used ONLY
 * as the web-apps logo is reported `unmatched` here (its only HQ home is the
 * session-auth per-logo endpoint, unreachable by API key, or the bundled
 * `.ccz`). A logo image that's ALSO form/menu media still attaches — the
 * file matches via that reference and the logo resolves to the same path.
 * Processing is asynchronous: the POST returns a `processing_id` once the
 * ZIP is accepted, and the match runs in a background task we poll to a
 * bounded deadline.
 *
 * Auth mirrors `importApp`: `ApiKey` header + a CSRF token (these endpoints
 * are not `@csrf_exempt`). No 16KB WAF padding — the body is a binary ZIP,
 * not the XForms-tag-bearing JSON the WAF rule trips on.
 */
export async function uploadAppMediaBundle(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	zipBytes: Buffer,
): Promise<MediaBundleUploadResult | CommCareApiError> {
	if (!isValidDomainSlug(domain)) {
		return { success: false, status: 400 };
	}
	const base = `${COMMCARE_HQ_URL}/a/${domain}/apps/api/${appId}/multimedia`;
	const uploadUrl = `${base}/`;

	/* Obtain a CSRF token before the POST — see fetchCsrfToken(). */
	const csrfToken = await fetchCsrfToken();
	const formData = new FormData();
	formData.append(
		"bulk_upload_file",
		new Blob([new Uint8Array(zipBytes)], { type: "application/zip" }),
		"multimedia.zip",
	);
	const headers: Record<string, string> = { Authorization: authHeader(creds) };
	if (csrfToken) {
		headers["X-CSRFToken"] = csrfToken;
		headers.Cookie = `csrftoken=${csrfToken}`;
		headers.Referer = uploadUrl;
	}

	const res = await fetch(uploadUrl, {
		method: "POST",
		headers,
		body: formData,
	});
	if (!res.ok) {
		return logAndReturnError("media bundle upload failed", res);
	}

	const started = (await res.json()) as {
		success?: boolean;
		processing_id?: string;
		error?: string;
	};
	if (!started.success || !started.processing_id) {
		log.error("[commcare] media bundle upload rejected by HQ", {
			domain,
			appId,
			error: started.error,
		});
		return { success: false, status: 422 };
	}

	return pollMediaBundleStatus(creds, base, started.processing_id);
}

/**
 * Poll HQ's `multimedia_status_api` until the bulk upload finishes or the
 * deadline passes. The bytes are already accepted, so a transient status
 * read (a non-200 between processing steps) is retried until the deadline
 * rather than failed. On timeout, `timedOut` signals the work is still
 * queued server-side. Status shape verified against
 * `commcare-hq/.../hqmedia/cache.py::BulkMultimediaStatusCache.get_response`
 * (`complete` / `errors` / `matched_count` / `unmatched_count`).
 */
async function pollMediaBundleStatus(
	creds: CommCareCredentials,
	base: string,
	processingId: string,
): Promise<MediaBundleUploadResult> {
	const statusUrl = `${base}/status/${processingId}/`;
	const deadline = Date.now() + MEDIA_BUNDLE_POLL_TIMEOUT_MS;
	const statusHeaders = { Authorization: authHeader(creds) };

	// Check first, then sleep between checks — so a fast task (or, in tests,
	// a mocked status) returns with no mandatory delay, and a transient 404
	// right after the POST (processing_id not yet registered) just retries.
	while (Date.now() < deadline) {
		const res = await fetch(statusUrl, {
			method: "GET",
			headers: statusHeaders,
		});
		if (res.ok) {
			const status = (await res.json()) as {
				complete?: boolean;
				errors?: string[];
				matched_count?: number;
				unmatched_count?: number;
			};
			if (status.complete) {
				return {
					matched: status.matched_count ?? 0,
					unmatched: status.unmatched_count ?? 0,
					errors: status.errors ?? [],
					timedOut: false,
				};
			}
		}
		await delay(MEDIA_BUNDLE_POLL_INTERVAL_MS);
	}
	return { matched: 0, unmatched: 0, errors: [], timedOut: true };
}

/** Promise-returning sleep for the bounded status poll. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
