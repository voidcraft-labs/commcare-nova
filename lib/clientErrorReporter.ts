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
import {
	type ClientErrorPayload,
	type ErrorSource,
	type NormalizedClientErrorPayload,
	normalizeClientErrorPayload,
} from "@/lib/clientErrorContract";

export type {
	ClientErrorDiagnostics,
	ClientErrorPayload,
	ErrorSource,
} from "@/lib/clientErrorContract";

// ── Dedup + Rate Limiting ──────────────────────────────────────────────

/** Max unique errors reported per page load. Prevents crash loop floods. */
const MAX_ERRORS_PER_SESSION = 10;

/**
 * Fingerprints of already-reported errors. Structured failures use their
 * stable category + app id; generic reports fall back to message + source.
 */
const reported = new Set<string>();

/** Generate a dedup key from the error payload. */
function fingerprint(payload: NormalizedClientErrorPayload): string {
	const { appId, component, operation, failureKind } = payload.diagnostics;
	if (component && operation && failureKind) {
		return [payload.source, component, operation, failureKind, appId]
			.filter(Boolean)
			.join("::");
	}
	return [payload.source, payload.message.slice(0, 200)]
		.filter(Boolean)
		.join("::");
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
 * with nothing thrown), synthesizes an Error, preserves a caller-supplied
 * stack when one exists, and supplies a stable explicit fingerprint for
 * structured failures.
 */
function captureToSentry(
	payload: NormalizedClientErrorPayload,
	thrown: unknown,
): void {
	try {
		let error = thrown;
		if (error === undefined) {
			const synthetic = new Error(payload.message);
			if (payload.stack !== undefined) synthetic.stack = payload.stack;
			error = synthetic;
		}
		const { appId, component, operation, failureKind } = payload.diagnostics;
		const tags = Object.fromEntries(
			Object.entries({
				source: payload.source,
				appId,
				component,
				operation,
				failureKind,
			}).filter((entry): entry is [string, string] => Boolean(entry[1])),
		);
		const explicitFingerprint =
			component &&
			operation &&
			failureKind &&
			(thrown === undefined || operation === "mutation-frame")
				? { fingerprint: [component, operation, failureKind] }
				: {};
		Sentry.captureException(error, {
			tags,
			extra: { source: payload.source, url: payload.url },
			contexts: { client_error: { ...payload.diagnostics } },
			...explicitFingerprint,
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
function send(payload: NormalizedClientErrorPayload): void {
	try {
		const body = JSON.stringify(payload);

		if (typeof navigator !== "undefined" && navigator.sendBeacon) {
			const blob = new Blob([body], { type: "application/json" });
			if (navigator.sendBeacon(ENDPOINT, blob)) return;
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
 * Deduplicates by stable diagnostics + app id (falling back to message +
 * source) so the same error isn't reported multiple times. Rate-limited to
 * MAX_ERRORS_PER_SESSION per page load.
 * Returns true if the error was actually sent, false if deduplicated
 * or rate-limited.
 */
export function reportClientError(
	payload: ClientErrorPayload,
	thrown?: unknown,
): boolean {
	const normalized = normalizeClientErrorPayload(payload);
	const key = fingerprint(normalized);

	/* Already reported this exact error. */
	if (reported.has(key)) return false;

	/* Rate limit reached — stop sending for this page load. */
	if (reported.size >= MAX_ERRORS_PER_SESSION) return false;

	reported.add(key);
	if (!SENTRY_NATIVE_SOURCES.has(normalized.source)) {
		captureToSentry(normalized, thrown);
	}
	send(normalized);
	return true;
}
