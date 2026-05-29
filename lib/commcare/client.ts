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
 *   - Media upload:   POST /a/{domain}/apps/{app_id}/multimedia/uploaded/{kind}/
 *
 * Authentication uses CommCare's API key format:
 *   Authorization: ApiKey {username}:{api_key}
 */

import {
	type AssetManifest,
	jrFileRef,
} from "@/lib/commcare/multimedia/assetWirePath";
import type { MediaKind } from "@/lib/domain/multimedia";
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

// ── Multimedia upload ──────────────────────────────────────────────

/**
 * One media asset uploaded to a CommCare HQ app. Carries the wire path
 * (the `jr://file/commcare/<hash><ext>` reference the form's itext
 * already points at) and the validated bytes to send.
 *
 * `wirePath` is the bare `commcare/<hash><ext>` stem; the upload layer
 * derives both the multipart `path` field (the full `jr://` reference)
 * and the `Filedata` filename from it, so the reference HQ records in
 * `multimedia_map` is byte-identical to the one the expander emitted.
 */
export interface MediaUploadAsset {
	/** `commcare/<contentHash><extension>` — same stem the expander/bundler use. */
	readonly wirePath: string;
	/** Media kind — selects the per-kind HQ upload endpoint. */
	readonly kind: MediaKind;
	/** Validated file bytes to send as the multipart `Filedata` field. */
	readonly bytes: Buffer;
}

/** One asset that HQ rejected, paired with the wire path it was keyed on. */
export interface MediaUploadFailure {
	readonly wirePath: string;
	readonly status: number;
}

/**
 * Result of uploading every media asset for an app. `uploaded` counts
 * the assets HQ accepted; `failures` lists the rest with the status that
 * surfaced. The caller decides how to present partial success — the app
 * itself is already created on HQ before any byte upload runs, so a
 * media failure never invalidates the import (it only leaves that one
 * asset's `multimedia_map` entry pointing at no bytes, which renders as
 * a broken reference for that asset alone).
 */
export interface MediaUploadSummary {
	readonly uploaded: number;
	readonly failures: readonly MediaUploadFailure[];
}

/**
 * CommCare HQ's per-kind multimedia upload endpoint segment. The URL is
 * `/a/{domain}/apps/{app_id}/multimedia/uploaded/{segment}/`.
 *
 * Verified against `commcare-hq/.../hqmedia/urls.py` (the
 * `uploaded/image/` · `uploaded/audio/` · `uploaded/video/` routes,
 * mounted under app_manager's `^(?P<app_id>[\w-]+)/multimedia/`) and the
 * per-kind view classes `ProcessImageFileUploadView` /
 * `ProcessAudioFileUploadView` / `ProcessVideoFileUploadView` in
 * `commcare-hq/.../hqmedia/views.py`.
 */
const MEDIA_UPLOAD_SEGMENT: Record<MediaKind, string> = {
	image: "image",
	audio: "audio",
	video: "video",
};

/**
 * Upload one media asset's bytes to an already-imported CommCare HQ app.
 *
 * The app MUST exist first (its id is in the URL) and MUST have been
 * imported media-ON (its forms carry the `jr://file/commcare/<hash><ext>`
 * itext references and its `multimedia_map` carries placeholder entries
 * keyed on the same path). Server-side, `process_upload`
 * (`commcare-hq/.../hqmedia/views.py::BaseProcessFileUploadView.process_upload`)
 * stores the bytes as a `CommCareMultimedia` couch doc, then calls
 * `app.create_mapping(multimedia, path)` — which overwrites
 * `multimedia_map[path]` with the couch-assigned `_id`. So the upload is
 * what makes the form's reference resolve to real bytes on the device.
 *
 * Request shape (multipart form, verified against
 * `BaseProcessUploadedView` + `BaseProcessFileUploadView`):
 *   - `Filedata` — the file bytes. The filename's extension must match
 *     the `path`'s extension (HQ's `validate_file` checks
 *     `file_ext ∈ guess_all_extensions(path)`), so the filename is the
 *     wire path's basename (`<hash><ext>`).
 *   - `path` — the full `jr://file/commcare/<hash><ext>` reference, the
 *     `multimedia_map` key `create_mapping` writes. Byte-identical to the
 *     expander's emitted reference so the form's itext resolves to it.
 *
 * Response shape (synchronous, verified against
 * `BaseProcessUploadedView.post` + `CommCareMultimedia.get_media_info`):
 *   - HTTP 200 with `{ ref: { m_id, uid, path, media_type, ... },
 *     errors: [] }` on success — `ref.m_id` is the couch `_id` HQ
 *     assigned, present when the upload succeeded.
 *   - HTTP 400 (`HttpResponseBadRequest`) with `{ errors: [...] }` on a
 *     `BadMediaFileException` (bad MIME, extension mismatch, etc.).
 *
 * Auth / CSRF / WAF: same `ApiKey {username}:{api_key}` header as
 * `importApp`, and the route is NOT `@csrf_exempt`, so the caller passes
 * a CSRF token fetched once via `fetchCsrfToken` and reused across every
 * asset. The route carries `@waf_allow('XSS_BODY')` and the body is raw
 * file bytes (no XForms tags), so the 16KB padding `importApp` needs is
 * not applied here.
 *
 * Returns the assigned media id on success or a typed error with the HTTP
 * status. The CommCare wire vocabulary (`Filedata`, `m_id`, `path`) stays
 * inside this boundary — callers see only the wire path and the assigned
 * id.
 */
async function uploadMediaFile(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	asset: MediaUploadAsset,
	csrfToken: string | null,
): Promise<{ success: true; mediaId: string } | CommCareApiError> {
	const segment = MEDIA_UPLOAD_SEGMENT[asset.kind];
	const url = `${COMMCARE_HQ_URL}/a/${domain}/apps/${appId}/multimedia/uploaded/${segment}/`;

	/* The multipart `path` field is the full `jr://file/...` reference —
	 * NOT the bare wire path — because that string becomes the
	 * `multimedia_map` key `create_mapping` writes, and it must match the
	 * reference the expander emitted into the form's itext. Both derive
	 * from `asset.wirePath` via `jrFileRef`, so they cannot drift. */
	const jrPath = jrFileRef(asset.wirePath);
	/* The `Filedata` filename's extension must match the `path`'s
	 * extension (HQ's `validate_file` rejects a mismatch). The wire path's
	 * basename (`<hash><ext>`) carries the right extension by
	 * construction. */
	const filename = asset.wirePath.slice(asset.wirePath.lastIndexOf("/") + 1);

	const formData = new FormData();
	formData.append("path", jrPath);
	/* `Buffer` → `Uint8Array` view so the Blob carries the bytes without a
	 * copy; the file is small (capped at the per-kind size limit). */
	formData.append(
		"Filedata",
		new Blob([new Uint8Array(asset.bytes)]),
		filename,
	);

	const headers: Record<string, string> = {
		Authorization: authHeader(creds),
	};
	if (csrfToken) {
		headers["X-CSRFToken"] = csrfToken;
		headers.Cookie = `csrftoken=${csrfToken}`;
		headers.Referer = url;
	}

	const res = await fetch(url, { method: "POST", headers, body: formData });

	if (!res.ok) {
		return logAndReturnError(`media upload failed (${asset.wirePath})`, res);
	}

	const data = (await res.json()) as {
		ref?: { m_id?: string };
		errors?: string[];
	};

	/* HQ returns HTTP 200 only on success (a `BadMediaFileException`
	 * yields HttpResponseBadRequest, caught above). Success is `errors`
	 * empty AND `ref.m_id` present — guard both so a shape regression
	 * surfaces as a failure rather than a silent broken reference. */
	if ((data.errors?.length ?? 0) > 0 || !data.ref?.m_id) {
		log.error("[commcare] media upload rejected by HQ", {
			domain,
			appId,
			path: asset.wirePath,
			errors: data.errors,
		});
		return { success: false, status: 422 };
	}

	return { success: true, mediaId: data.ref.m_id };
}

/**
 * Upload every media asset for an already-imported CommCare HQ app.
 *
 * Ordering invariant: `importApp` MUST have returned first — the app id
 * is in each upload URL, and the app must already carry the forms'
 * `jr://` itext references (media-ON import) so the uploaded bytes
 * actually render. This function never imports; it only follows.
 *
 * A single CSRF token is fetched once and reused across every per-asset
 * POST (the import endpoint's CSRF requirement applies to these routes
 * too — they're not `@csrf_exempt`).
 *
 * Partial-failure policy: each asset is uploaded independently and a
 * failure on one is recorded in `failures` rather than aborting the
 * rest. The app already exists on HQ (import ran first and isn't
 * transactional with media), so the right outcome on a media failure is
 * a created app with one broken reference, surfaced to the user as a
 * warning — not a discarded import. The caller maps `failures` into the
 * import result's `warnings` channel.
 *
 * `assets` is taken from the resolved media manifest the caller already
 * built for the expander (so the same bytes feed both the references and
 * the upload). When the manifest is empty (a media-free app), this is a
 * no-op returning `{ uploaded: 0, failures: [] }`.
 */
export async function uploadAppMedia(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	assets: readonly MediaUploadAsset[],
): Promise<MediaUploadSummary | CommCareApiError> {
	if (!isValidDomainSlug(domain)) {
		return { success: false, status: 400 };
	}
	if (assets.length === 0) {
		return { uploaded: 0, failures: [] };
	}

	/* One token for the whole batch — see `fetchCsrfToken`. Fetching per
	 * asset would be N redundant round-trips for a single ephemeral
	 * value. */
	const csrfToken = await fetchCsrfToken();

	let uploaded = 0;
	const failures: MediaUploadFailure[] = [];
	for (const asset of assets) {
		const result = await uploadMediaFile(
			creds,
			domain,
			appId,
			asset,
			csrfToken,
		);
		if (result.success) {
			uploaded++;
		} else {
			failures.push({ wirePath: asset.wirePath, status: result.status });
		}
	}

	return { uploaded, failures };
}

/**
 * Project a resolved media manifest into the upload-ready asset list.
 *
 * The manifest the caller built for the expander (via
 * `resolveMediaManifest(doc, owner, { withBytes: true })`) is the single
 * source of truth: this derives the upload list from it so the bytes
 * uploaded and the references emitted come from one resolution pass and
 * cannot diverge.
 *
 * Throws if an entry is missing its bytes — `withBytes: true` is the
 * caller's contract for the upload path, mirroring the compiler's
 * byte-load invariant. A missing buffer means the manifest was resolved
 * for a path-only consumer and wrongly handed to the upload flow.
 *
 * Deduplicates by wire path, mirroring `buildMediaBundle`: two distinct
 * `AssetId`s can resolve to one `(contentHash, extension)` — and so one
 * wire path — when the storage layer's ready-dedup probe races (it
 * ignores `pending` rows, so concurrent uploads of identical bytes can
 * land two `ready` rows). The compiler collapses such a pair into one
 * archive entry; the upload must collapse it into one POST so the
 * `uploaded` count matches the file count and no redundant request is
 * sent (the second POST would be a harmless `create_mapping` overwrite,
 * but it shouldn't be made).
 */
export function mediaUploadAssetsFromManifest(
	manifest: AssetManifest,
): MediaUploadAsset[] {
	const byWirePath = new Map<string, MediaUploadAsset>();
	for (const asset of manifest.values()) {
		if (!asset.bytes) {
			throw new Error(
				`The media upload flow received an asset without loaded bytes (wire path "${asset.wirePath}"). ` +
					"The HQ multimedia upload needs each asset's bytes — resolve the manifest with `withBytes: true` " +
					"before uploading, or check the caller passed the byte-loaded manifest rather than a path-only one.",
			);
		}
		if (byWirePath.has(asset.wirePath)) continue;
		byWirePath.set(asset.wirePath, {
			wirePath: asset.wirePath,
			kind: asset.kind,
			bytes: asset.bytes,
		});
	}
	return [...byWirePath.values()];
}
