/**
 * Client-side error reporting — sends error payloads to the server
 * logging endpoint for ingestion into GCP Cloud Logging.
 *
 * Uses `navigator.sendBeacon` for reliability (survives page unloads,
 * tab closures, and navigation away). Falls back to `fetch` with
 * `keepalive: true` when sendBeacon isn't available.
 *
 * Includes client-side deduplication (same error won't be reported twice)
 * and rate limiting (max errors per page load) to prevent crash loops
 * from flooding the logging endpoint.
 */

// ── Types ──────────────────────────────────────────────────────────────

/** The source that captured the error — used for filtering in Cloud Logging. */
export type ErrorSource =
	| "window.onerror"
	| "unhandledrejection"
	| "error-boundary"
	| "manual";

/** Payload sent to the server logging endpoint. */
export interface ClientErrorPayload {
	message: string;
	stack?: string;
	source: ErrorSource;
	url: string;
	/** React component stack from error boundaries (separate from JS stack). */
	componentStack?: string;
}

// ── Dedup + Rate Limiting ──────────────────────────────────────────────

/** Max unique errors reported per page load. Prevents crash loop floods. */
const MAX_ERRORS_PER_SESSION = 10;

/**
 * Fingerprints of already-reported errors. Uses the first 200 chars of
 * message + source as a simple dedup key — good enough to catch repeated
 * errors without the overhead of full hashing.
 */
const reported = new Set<string>();

/** Generate a dedup key from the error payload. */
function fingerprint(payload: ClientErrorPayload): string {
	return `${payload.source}::${payload.message.slice(0, 200)}`;
}

// ── Transport ──────────────────────────────────────────────────────────

const ENDPOINT = "/api/log/error";

/**
 * Send the error payload to the server. Prefers `sendBeacon` for
 * reliability during page unloads; falls back to `fetch` with `keepalive`.
 * Never throws — reporting errors should not cause additional errors.
 */
function send(payload: ClientErrorPayload): void {
	try {
		const body = JSON.stringify(payload);

		if (typeof navigator !== "undefined" && navigator.sendBeacon) {
			const blob = new Blob([body], { type: "application/json" });
			navigator.sendBeacon(ENDPOINT, blob);
			return;
		}

		/* Fallback for environments without sendBeacon (rare, but defensive). */
		fetch(ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			keepalive: true,
		}).catch(() => {
			/* swallow — we can't report a reporting failure */
		});
	} catch {
		/* Swallow — error reporting must never throw */
	}
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Report a client-side error to the server logging endpoint.
 *
 * Deduplicates by message + source so the same error isn't reported
 * multiple times. Rate-limited to MAX_ERRORS_PER_SESSION per page load.
 * Returns true if the error was actually sent, false if deduplicated
 * or rate-limited.
 */
export function reportClientError(payload: ClientErrorPayload): boolean {
	const key = fingerprint(payload);

	/* Already reported this exact error. */
	if (reported.has(key)) return false;

	/* Rate limit reached — stop sending for this page load. */
	if (reported.size >= MAX_ERRORS_PER_SESSION) return false;

	reported.add(key);
	send(payload);
	return true;
}
