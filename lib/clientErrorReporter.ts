/**
 * Client-side error reporting — the single funnel every browser error
 * path goes through. Fans out to two channels:
 *
 * - **Cloud Logging** via the server logging endpoint, using
 *   `navigator.sendBeacon` for reliability (survives page unloads, tab
 *   closures, and navigation away), falling back to `fetch` with
 *   `keepalive: true`.
 * - **Sentry**, for the sources its SDK can't see on its own. React
 *   marks boundary-caught errors as handled and manual reports are
 *   caught by application code, so neither reaches Sentry's global
 *   handlers — this funnel captures them. `window.onerror` /
 *   `unhandledrejection` are skipped: the SDK already captured those
 *   first-hand, and a second capture would double every uncaught error.
 *
 * Includes client-side deduplication (same error won't be reported twice)
 * and rate limiting (max errors per page load) to prevent crash loops
 * from flooding either channel.
 */

import * as Sentry from "@sentry/nextjs";

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

// ── Sentry capture ─────────────────────────────────────────────────────

/**
 * Sources the Sentry browser SDK captures first-hand through its global
 * handlers — for these the Sentry copy already exists by the time this
 * reporter runs, so only the Cloud Logging relay is needed.
 */
const SENTRY_NATIVE_SOURCES: ReadonlySet<ErrorSource> = new Set([
	"window.onerror",
	"unhandledrejection",
]);

/**
 * Capture a boundary/manual report to Sentry. Prefers the original
 * thrown value — Sentry fingerprints on its stack, which groups far
 * better than message text. Without one (e.g. an HTTP-status failure
 * with nothing thrown), synthesizes an Error carrying the payload's
 * stack so grouping keys on the original frames, not this reporter's.
 */
function captureToSentry(payload: ClientErrorPayload, thrown: unknown): void {
	try {
		let error = thrown;
		if (error === undefined) {
			const synthetic = new Error(payload.message);
			if (payload.stack) synthetic.stack = payload.stack;
			error = synthetic;
		}
		Sentry.captureException(error, {
			extra: { source: payload.source, url: payload.url },
		});
	} catch {
		/* Swallow — error reporting must never throw */
	}
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
 * Report a client-side error to Cloud Logging (via the server endpoint)
 * and Sentry (for sources the SDK doesn't capture natively).
 *
 * Pass the original thrown value as `thrown` whenever one exists — the
 * Sentry capture keeps its native stack for grouping.
 *
 * Deduplicates by message + source so the same error isn't reported
 * multiple times. Rate-limited to MAX_ERRORS_PER_SESSION per page load.
 * Returns true if the error was actually sent, false if deduplicated
 * or rate-limited.
 */
export function reportClientError(
	payload: ClientErrorPayload,
	thrown?: unknown,
): boolean {
	const key = fingerprint(payload);

	/* Already reported this exact error. */
	if (reported.has(key)) return false;

	/* Rate limit reached — stop sending for this page load. */
	if (reported.size >= MAX_ERRORS_PER_SESSION) return false;

	reported.add(key);
	if (!SENTRY_NATIVE_SOURCES.has(payload.source)) {
		captureToSentry(payload, thrown);
	}
	send(payload);
	return true;
}
