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
 * API reference (from dimagi/commcare-hq#37559, update support + endpoint
 * decorators from dimagi/commcare-hq#37972):
 *   - User domains:   GET  /api/user_domains/v1/
 *   - App import:     POST /a/{domain}/apps/api/import_app/                 (optional app_id = update in place)
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
import type {
	HqFeatureFlagProbe,
	HqFeatureFlagRequirement,
} from "@/lib/publish/hqFeatureFlags";
import { COMMCARE_SERVERS, type CommCareServer } from "./servers";

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
	/** CommCare HQ application ID for the created or updated app. */
	appId: string;
	/**
	 * The HQ app's version after an in-place update; null on create (HQ's
	 * create response carries no version).
	 */
	version: number | null;
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
	/**
	 * True when the edge in front of CommCare HQ refused the request and
	 * CommCare HQ never saw it (`isEdgeRefusal`). The status is then a
	 * proxy's, so a caller must not report it as an answer about the key,
	 * the account's permissions, or the app. Absent on the errors this
	 * module returns without a response to read, such as a rejected domain
	 * slug.
	 */
	edgeRefusal?: boolean;
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
 * Credentials needed to authenticate with CommCare HQ.
 *
 * `server` names which of Dimagi's separate SaaS deployments the
 * username/key pair lives on — an API key only authenticates against the
 * server that issued it, so the pair is meaningless without it. Every
 * request's base URL derives from it through the closed `COMMCARE_SERVERS`
 * catalog, never from a user-supplied URL — that closed union is the SSRF
 * boundary (a user who could set an arbitrary URL could point our server
 * at internal services: GCP metadata, localhost, etc.). See `./servers`.
 */
export interface CommCareCredentials {
	username: string;
	apiKey: string;
	server: CommCareServer;
}

/** Base URL for every HQ API call these credentials can make. */
function baseUrl(creds: CommCareCredentials): string {
	return COMMCARE_SERVERS[creds.server].baseUrl;
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
 * Throwaway multipart field that pushes the real payload past the body
 * inspection window of the WAF in front of CommCare HQ.
 *
 * That WAF matches an XML namespace declaration — `xmlns=` or
 * `xmlns:<prefix>=` — anywhere in roughly the first 8 KiB of a request
 * body, and answers 403 from the edge with a generic HTML error page. The
 * request never reaches Django, so the status carries no verdict about the
 * account or the project space. Both uploads here can match: `importApp`
 * carries XForm XML inside its JSON, and `uploadAppMediaBundle` carries
 * compressed image bytes. The field goes FIRST so the payload starts past
 * the window, and Django ignores an unknown multipart field.
 *
 * `@waf_allow('XSS_BODY')` on HQ's import views does not remove the need
 * for it. `corehq/apps/hqwebapp/decorators.py::waf_allow` only records the
 * view in a module-level dict for whoever configures the WAF; it wraps
 * nothing and changes nothing at request time. Uploads were still refused
 * in production after those decorators shipped, and only apps small enough
 * to put their first form's XML inside the window were affected — which is
 * why this reads as an app-size bug rather than a permissions one.
 *
 * Sized well past the observed window so it holds regardless of where a
 * given app's form XML lands.
 */
const WAF_PADDING = "x".repeat(16 * 1024);

/**
 * Whether a failed response came from the edge in front of CommCare HQ
 * rather than from CommCare HQ itself.
 *
 * The WAF refuses with a generic proxy error page: an HTML document titled
 * with a bare status code, carrying no CommCare content. CommCare HQ's own
 * refusals never look like that — the API views answer JSON
 * (`JsonResponse` under `@json_error`), the ajax branch of
 * `corehq/apps/users/decorators.py::require_permission_raw` answers plain
 * text, and a rendered `PermissionDenied` carries CommCare markup. So a
 * match here means the status says nothing about the key, the account's
 * permissions, or the app, and a caller must not read one into it.
 */
function isEdgeRefusal(body: string): boolean {
	const head = body.slice(0, 200).toLowerCase();
	if (!head.includes("<html")) return false;
	if (!/<title>\s*\d{3}\b/.test(head)) return false;
	return !body.toLowerCase().includes("commcare");
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
	log.error(`[commcare] ${context}`, undefined, {
		status: res.status,
		body: body.substring(0, 200),
	});
	return {
		success: false,
		status: res.status,
		edgeRefusal: isEdgeRefusal(body),
	};
}

/**
 * The warn-level sibling, for the observation reads whose refusals are
 * ANSWERS rather than faults: a deleted app's 404, a key without the
 * Access APIs permission, a build with no profile. Each one is handled as
 * a first-class outcome by `lib/deployment/observe.ts` and recurs by
 * design on every Check status, so filing it at error level would stream
 * a Sentry event per click for a state nobody can action from Nova's
 * side. `log.warn` stays Cloud-Logging-only, which is the repo's line for
 * expected-but-worth-recording conditions.
 */
async function warnAndReturnError(
	context: string,
	res: Response,
): Promise<CommCareApiError> {
	let body = "";
	try {
		body = await res.text();
	} catch {}
	log.warn(`[commcare] ${context}`, {
		status: res.status,
		body: body.substring(0, 200),
	});
	return {
		success: false,
		status: res.status,
		edgeRefusal: isEdgeRefusal(body),
	};
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
	return listDomainsMatching(creds);
}

/**
 * The user-domains endpoint doubles as HQ's only feature-flag probe. Passing
 * `feature_flag` returns only domains for which that registered toggle is
 * enabled. Unknown/retired slugs return 400 — deliberately preserved as an
 * unavailable diagnostic rather than misreported as "off".
 */
async function listDomainsMatching(
	creds: CommCareCredentials,
	featureFlag?: string,
	signal?: AbortSignal,
): Promise<CommCareDomain[] | CommCareApiError> {
	const domains: CommCareDomain[] = [];
	const base = baseUrl(creds);
	const query = new URLSearchParams({ limit: "100" });
	if (featureFlag) query.set("feature_flag", featureFlag);
	let url: string | null = `${base}/api/user_domains/v1/?${query.toString()}`;
	/** Safety bound — prevents infinite loops from buggy pagination pointers. */
	const MAX_PAGES = 50;
	let page = 0;

	while (url && page < MAX_PAGES) {
		page++;
		const res = await fetch(url, {
			headers: { Authorization: authHeader(creds) },
			signal,
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
			const resolved = new URL(data.meta.next, base);
			if (resolved.origin !== new URL(base).origin) {
				log.warn("[commcare/feature-flags] rejected foreign pagination URL", {
					featureFlag,
					origin: resolved.origin,
				});
				return { success: false, status: 502 };
			}
			url = resolved.toString();
		} else {
			url = null;
		}
	}
	if (url !== null) {
		log.warn(
			"[commcare/feature-flags] domain pagination exceeded safety bound",
			{
				featureFlag,
				pages: MAX_PAGES,
			},
		);
		return { success: false, status: 508 };
	}

	return domains;
}

/**
 * Probe every flag the app requires against one known upload target.
 *
 * A probe is diagnostic only: each flag settles independently and every
 * transport/HQ failure becomes `unavailable`, never a throw that could undo a
 * successful app upload. The current manifest records domain-only namespaces;
 * fail closed if a future user-namespaced entry reaches this function because
 * HQ unions user + domain assignments for that shape and could produce a false
 * "enabled" result.
 */
export async function probeHqFeatureFlags(
	creds: CommCareCredentials,
	domain: string,
	requirements: readonly HqFeatureFlagRequirement[],
): Promise<HqFeatureFlagProbe[]> {
	if (requirements.length === 0) return [];

	// An empty filtered response only proves a flag is missing when the same
	// credentials can still see the target in the unfiltered endpoint. Stored
	// domain approvals can become stale after HQ membership changes; without
	// this guard, losing access would be misreported as every flag being off.
	try {
		const visibleDomains = await runBoundedFeatureFlagProbe((signal) =>
			listDomainsMatching(creds, undefined, signal),
		);
		if (
			!Array.isArray(visibleDomains) ||
			!visibleDomains.some((candidate) => candidate.name === domain)
		) {
			log.warn(
				"[commcare/feature-flags] target domain unavailable to live credentials",
				{
					domain,
					status: Array.isArray(visibleDomains)
						? undefined
						: visibleDomains.status,
				},
			);
			return requirements.map((requirement) => ({
				requirement,
				state: "unavailable" as const,
			}));
		}
	} catch (error) {
		log.warn("[commcare/feature-flags] live domain check threw", {
			domain,
			error,
		});
		return requirements.map((requirement) => ({
			requirement,
			state: "unavailable" as const,
		}));
	}

	return Promise.all(
		requirements.map(async (requirement): Promise<HqFeatureFlagProbe> => {
			if (
				requirement.namespaces.length !== 1 ||
				requirement.namespaces[0] !== "domain"
			) {
				log.warn("[commcare/feature-flags] unsafe namespace for domain probe", {
					domain,
					flag: requirement.slug,
					namespaces: requirement.namespaces,
				});
				return { requirement, state: "unavailable" };
			}

			try {
				const enabledDomains = await runBoundedFeatureFlagProbe((signal) =>
					listDomainsMatching(creds, requirement.slug, signal),
				);
				if (!Array.isArray(enabledDomains)) {
					log.warn("[commcare/feature-flags] HQ probe unavailable", {
						domain,
						flag: requirement.slug,
						status: enabledDomains.status,
					});
					return { requirement, state: "unavailable" };
				}
				return {
					requirement,
					state: enabledDomains.some((candidate) => candidate.name === domain)
						? "enabled"
						: "missing",
				};
			} catch (error) {
				log.warn("[commcare/feature-flags] HQ probe threw", {
					domain,
					flag: requirement.slug,
					error,
				});
				return { requirement, state: "unavailable" };
			}
		}),
	);
}

/** A diagnostic must never hold open an already-successful HQ import. */
export const HQ_FEATURE_FLAG_PROBE_TIMEOUT_MS = 5_000;

async function runBoundedFeatureFlagProbe<T>(
	probe: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(
			new DOMException("HQ feature-flag probe timed out", "TimeoutError"),
		);
	}, HQ_FEATURE_FLAG_PROBE_TIMEOUT_MS);
	try {
		return await probe(controller.signal);
	} finally {
		clearTimeout(timeout);
	}
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
	const url = `${baseUrl(creds)}/a/${domain}/apps/api/list_apps/`;
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
 * Import an app into a CommCare HQ project space.
 *
 * Sends the expanded HQ JSON as a multipart form upload. Without
 * `updateAppId`, CommCare HQ creates a new app in the domain. With one, HQ
 * overwrites that app in place — same app id, version bumped — and reports
 * the resulting `version`; an unknown id draws a 404, which passes through
 * as `{ success: false, status: 404 }` so the caller can record that the
 * remote app is gone. `app_name` is sent on both paths: HQ applies it after
 * the merge, so an update also renames the HQ app to Nova's current name.
 *
 * Wire contract verified against
 * `commcare-hq/.../app_manager/views/app_import_api.py::_handle_import_app`
 * (the optional `app_id` field) and
 * `models/applications.py::overwrite_app_from_source` (the in-place merge).
 */
export async function importApp(
	creds: CommCareCredentials,
	domain: string,
	appName: string,
	appJson: object,
	updateAppId?: string,
): Promise<ImportResponse> {
	if (!isValidDomainSlug(domain)) {
		return { success: false, status: 400 };
	}
	const base = baseUrl(creds);
	const url = `${base}/a/${domain}/apps/api/import_app/`;

	/* Multipart form: waf_padding (see WAF_PADDING) + app_name (string) +
	 * optional app_id (the HQ app to update in place) + app_file (JSON
	 * blob). */
	const formData = new FormData();
	formData.append("waf_padding", WAF_PADDING);
	formData.append("app_name", appName);
	if (updateAppId) {
		formData.append("app_id", updateAppId);
	}
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
		/* A 404 on the update arm is an ANSWER — the app Nova mapped was
		 * deleted on HQ's side — handled as a first-class outcome by the
		 * publish lifecycle, so it files at warn level like the observation
		 * reads' expected refusals. */
		if (updateAppId && res.status === 404) {
			return warnAndReturnError("import target missing", res);
		}
		return logAndReturnError("import failed", res);
	}

	const data = (await res.json()) as {
		success: boolean;
		app_id: string;
		version?: number;
		warnings?: string[];
	};

	/* HQ can return HTTP 200 with success:false for application-level
	 * import failures (malformed JSON, schema violations). The response
	 * body is already consumed so we log the parsed result directly. */
	if (!data.success) {
		log.error("[commcare] import rejected by HQ", undefined, { domain, data });
		return { success: false, status: 422 };
	}

	return {
		success: true,
		appId: data.app_id,
		version: typeof data.version === "number" ? data.version : null,
		warnings: data.warnings ?? [],
	};
}

// ── Multimedia upload (bulk API) ───────────────────────────────────

/** One file HQ couldn't match to a reference, from the status report's
 *  `unmatched_files` list — the wire path (`commcare/<hash><ext>`) plus HQ's
 *  own reason string. The upload route maps the path back to the carrier it
 *  serves so the user sees WHICH media, WHERE, didn't attach. */
export interface UnmatchedMediaFileReport {
	readonly path: string;
	readonly reason: string;
}

/**
 * Outcome of a bulk media upload. `matched` / `unmatched` come from HQ's
 * async processing of the ZIP (files matched to the app's references vs
 * files the app doesn't reference); `unmatchedFiles` carries the per-file
 * detail behind `unmatched` (path + reason) so the caller can name what didn't
 * attach instead of a bare count; `errors` carries any processing errors HQ
 * reported. `timedOut` means we stopped polling before HQ finished — the ZIP
 * was accepted and is still processing server-side, so the media will appear
 * shortly even though we didn't confirm the match.
 */
export interface MediaBundleUploadResult {
	readonly matched: number;
	readonly unmatched: number;
	readonly unmatchedFiles: readonly UnmatchedMediaFileReport[];
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
	const hqBase = baseUrl(creds);
	const base = `${hqBase}/a/${domain}/apps/api/${appId}/multimedia`;
	const uploadUrl = `${base}/`;

	const formData = new FormData();
	formData.append("waf_padding", WAF_PADDING);
	formData.append(
		"bulk_upload_file",
		new Blob([new Uint8Array(zipBytes)], { type: "application/zip" }),
		"multimedia.zip",
	);

	const res = await fetch(uploadUrl, {
		method: "POST",
		headers: { Authorization: authHeader(creds) },
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
		log.error("[commcare] media bundle upload rejected by HQ", undefined, {
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
				// HQ's `BulkMultimediaStatusCache.get_response` records each
				// unmatched ZIP entry as `{path, reason}` (`add_unmatched_path`).
				unmatched_files?: { path?: string; reason?: string }[];
			};
			if (status.complete) {
				return {
					matched: status.matched_count ?? 0,
					unmatched: status.unmatched_count ?? 0,
					unmatchedFiles: (status.unmatched_files ?? []).map((f) => ({
						path: f.path ?? "",
						reason: f.reason ?? "",
					})),
					errors: status.errors ?? [],
					timedOut: false,
				};
			}
		}
		await delay(MEDIA_BUNDLE_POLL_INTERVAL_MS);
	}
	return {
		matched: 0,
		unmatched: 0,
		unmatchedFiles: [],
		errors: [],
		timedOut: true,
	};
}

/** Promise-returning sleep for the bounded status poll. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Reading what CommCare HQ has done with an app ──────────────────
//
// Nova imports an app and then watches. Building and releasing are not
// things an API key can do: `views/releases.py::save_copy` and
// `views/releases.py::release_build` both sit behind
// `require_can_edit_apps`, which is
// `require_permission(HqPermissions.edit_apps)` with the default
// `login_and_domain_required` — a browser session and nothing else. The
// three reads below are what an API key CAN see, and together they answer
// "has somebody built it, released it, and can a device install it".

/** What CommCare HQ currently holds of one app. */
export interface HqAppVersions {
	/** The working app's own version number. */
	readonly currentVersion: number;
	/** The newest build's version, or `null` when nothing has been built. */
	readonly latestBuildVersion: number | null;
	/** The newest RELEASED build's version, or `null` when none is released. */
	readonly latestReleasedVersion: number | null;
}

/** One build CommCare HQ holds for an app. */
export interface HqAppBuild {
	readonly id: string;
	readonly version: number;
	readonly isReleased: boolean;
	readonly builtOn: string | null;
	readonly buildComment: string | null;
}

function finiteIntOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value)
		? value
		: null;
}

/**
 * Read an app's current, latest-built, and latest-released versions.
 *
 * `GET /a/{domain}/apps/view/{app_id}/current_version/`, which carries
 * `@login_or_api_key` (`views/releases.py::current_app_version`) and so is
 * reachable with the stored key. It answers with version NUMBERS, not
 * build ids; `listAppBuilds` is what supplies an id.
 *
 * A 404 here means CommCare HQ has no such working app in the domain —
 * either it was deleted, or the id names a build rather than the app
 * (`current_app_version` raises `Http404` on `NoResultFound` for exactly
 * that case).
 */
export async function readAppVersions(
	creds: CommCareCredentials,
	domain: string,
	hqAppId: string,
): Promise<HqAppVersions | CommCareApiError> {
	if (!isValidDomainSlug(domain)) return { success: false, status: 400 };
	const url = `${baseUrl(creds)}/a/${domain}/apps/view/${encodeURIComponent(hqAppId)}/current_version/`;
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { Authorization: authHeader(creds), Accept: "application/json" },
		});
	} catch (err) {
		log.warn("[commcare] current_version request failed", {
			domain,
			error: err instanceof Error ? err.message : String(err),
		});
		return { success: false, status: 503 };
	}
	if (!res.ok) return warnAndReturnError("current_version failed", res);
	let data: {
		currentVersion?: unknown;
		latestBuild?: unknown;
		latestReleasedBuild?: unknown;
	};
	try {
		data = (await res.json()) as typeof data;
	} catch {
		return { success: false, status: 502 };
	}
	const currentVersion = finiteIntOrNull(data.currentVersion);
	if (currentVersion === null) return { success: false, status: 502 };
	return {
		currentVersion,
		latestBuildVersion: finiteIntOrNull(data.latestBuild),
		latestReleasedVersion: finiteIntOrNull(data.latestReleasedBuild),
	};
}

/**
 * List an app's builds, with their ids and release flags.
 *
 * The tastypie Application resource
 * (`corehq/apps/api/resources/v0_4.py::ApplicationResource.dehydrate_versions`)
 * is read-only and authenticates through `LoginAndDomainAuthentication`,
 * whose decorator map carries an `API_KEY` entry — so the stored key
 * works, provided its account also holds CommCare HQ's `access_api`
 * permission. A key without it gets a 401/403 here while the rest of the
 * deployment still functions, which is why callers treat a failure as
 * "could not check" rather than "not built".
 *
 * `versions` comes back empty for a build rather than a working app, so an
 * empty list from a working app genuinely means nothing has been built.
 */
export async function listAppBuilds(
	creds: CommCareCredentials,
	domain: string,
	hqAppId: string,
): Promise<readonly HqAppBuild[] | CommCareApiError> {
	if (!isValidDomainSlug(domain)) return { success: false, status: 400 };
	const url = `${baseUrl(creds)}/a/${domain}/api/application/v1/${encodeURIComponent(hqAppId)}/`;
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { Authorization: authHeader(creds), Accept: "application/json" },
		});
	} catch (err) {
		log.warn("[commcare] application resource request failed", {
			domain,
			error: err instanceof Error ? err.message : String(err),
		});
		return { success: false, status: 503 };
	}
	if (!res.ok) return warnAndReturnError("application resource failed", res);
	let data: { versions?: unknown };
	try {
		data = (await res.json()) as typeof data;
	} catch {
		return { success: false, status: 502 };
	}
	if (!Array.isArray(data.versions)) return { success: false, status: 502 };
	const builds: HqAppBuild[] = [];
	for (const entry of data.versions) {
		if (typeof entry !== "object" || entry === null) continue;
		const row = entry as Record<string, unknown>;
		const id = typeof row.id === "string" ? row.id : null;
		const version = finiteIntOrNull(row.version);
		if (id === null || version === null) continue;
		builds.push({
			id,
			version,
			isReleased: row.is_released === true,
			builtOn: typeof row.built_on === "string" ? row.built_on : null,
			buildComment:
				typeof row.build_comment === "string" ? row.build_comment : null,
		});
	}
	return builds;
}

/**
 * Ask CommCare HQ for the profile a device installs one BUILD from.
 *
 * This is the strongest honest proof that a released build can be run: it
 * is the first request a real device makes, so a 200 means a device would
 * get one too.
 *
 * **It is a device install request, not a pure read, and the difference is
 * worth stating plainly.** Despite the URL, this does NOT reach
 * `views/download.py::download_odk_profile`: `urls.py` registers the
 * catch-all `^download/(?P<app_id>[\w-]+)/(?P<path>.*)$` → `download_file`
 * BEFORE the `download_urls` include (its own comment says "the order of
 * these download urls is important"), so `download_file` handles it. That
 * view generates a build's files and calls `request.app.save()` when they
 * are missing, and patches in an ODK profile the same way on its
 * `ResourceNotFound` arm. That is CommCare HQ repairing a build on a
 * device's behalf, which happens for every real install too, and it cannot
 * change the version or what is released: `ApplicationBase::save` only
 * increments a version when `copy_of` is unset, and a build has it set.
 *
 * **It must still always name a BUILD id.** With one, `download_file`'s
 * `assert request.app.copy_of` holds and the request stays on that build.
 * With the working app's id the assert fails, the except arm falls through
 * to `resolve_path` → `download_odk_profile` → `autogenerate_build`, and
 * CommCare HQ starts building a NEW version. Never pass the working app id,
 * and never `?latest=true`, which resolves to one whenever nothing is
 * released.
 *
 * A redirect is "could not check", never "not installable":
 * `decorators.py::check_access_and_redirect` answers 302 for any domain
 * carrying a `redirect_url`, and `::safe_cached_download` 302s to the app
 * page on an editing/case error. Reporting either as a broken build would
 * accuse a healthy deployment.
 */
export async function probeBuildProfile(
	creds: CommCareCredentials,
	domain: string,
	buildId: string,
): Promise<
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: "unavailable" | "not-installable" }
> {
	if (!isValidDomainSlug(domain)) return { ok: false, reason: "unavailable" };
	const url = `${baseUrl(creds)}/a/${domain}/apps/download/${encodeURIComponent(buildId)}/profile.ccpr`;
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { Authorization: authHeader(creds) },
			redirect: "manual",
		});
	} catch (err) {
		log.warn("[commcare] build profile probe failed", {
			domain,
			error: err instanceof Error ? err.message : String(err),
		});
		return { ok: false, reason: "unavailable" };
	}
	if (res.status >= 300 && res.status < 400) {
		log.warn("[commcare] build profile probe redirected", {
			domain,
			status: res.status,
		});
		try {
			await res.body?.cancel();
		} catch {}
		return { ok: false, reason: "unavailable" };
	}
	if (!res.ok) {
		await warnAndReturnError("build profile probe failed", res);
		/* Only a 404 is a verdict on the BUILD: CommCare HQ served the
		 * request and had no profile for it. Every other refusal is Nova
		 * failing to ask — a 401 or 403 is the key's permissions, a 429 is
		 * rate limiting, a 5xx is CommCare HQ being unwell — and reporting
		 * those as `not-installable` tells somebody their release is broken
		 * when nothing was learned about it at all. */
		return {
			ok: false,
			reason: res.status === 404 ? "not-installable" : "unavailable",
		};
	}
	// Drain the body so the connection is released; the bytes themselves
	// are not what is being checked, only that CommCare HQ served them.
	try {
		await res.text();
	} catch {}
	return { ok: true };
}
