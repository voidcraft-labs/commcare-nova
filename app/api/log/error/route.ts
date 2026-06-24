/**
 * Client error logging endpoint — receives browser-side errors and logs
 * them as structured JSON for GCP Cloud Logging.
 *
 * No auth required — errors can happen before, during, or after
 * authentication (sign-in flow errors, token expiry, etc.). The endpoint
 * validates and sanitizes the payload to prevent abuse.
 *
 * Uses the structured logger (`lib/logger.ts`) so these errors appear in
 * Cloud Logging with proper severity, stack traces for Error Reporting
 * grouping, and filterable `source: client` labels alongside server errors.
 */
import { z } from "zod/v4";
import { CLIENT_ERROR_MAX_BYTES, declaredBodyTooLarge } from "@/lib/apiError";
import { log } from "@/lib/logger";

// ── Payload Schema ────────────────────────────────────────────────────

/** Max length for string fields to prevent oversized payloads. */
const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;
const MAX_URL = 2000;

// ── Server-side flood control ─────────────────────────────────────────
//
// This endpoint is intentionally public, and the only client-side throttle
// (`lib/clientErrorReporter.ts`) is bypassed by a direct HTTP caller. Without
// a bound, an anonymous client can emit unbounded production `ERROR` records —
// Cloud Logging cost + alert fatigue (CWE-770).
//
// The rate limit lives at the EDGE in Cloud Armor, NOT in app code: a per-IP
// throttle rule (60 req / 60s → 429) on the `nova-armor` security policy
// attached to the Global External Application Load Balancer that fronts Cloud
// Run drops the flood before it reaches this service (so it costs no Cloud Run
// request at all). See `scripts/infra/setup-cloud-armor-lb.sh`. The route keeps
// only the per-request body-size cap below; aggregate request-rate control is
// the edge's job.

const clientErrorSchema = z.object({
	message: z.string().max(MAX_MESSAGE),
	stack: z.string().max(MAX_STACK).optional(),
	source: z.enum([
		"window.onerror",
		"unhandledrejection",
		"error-boundary",
		"manual",
	]),
	url: z.string().max(MAX_URL),
	componentStack: z.string().max(MAX_STACK).optional(),
});

// ── Route Handler ─────────────────────────────────────────────────────

export async function POST(req: Request) {
	// Reject a declared-oversized body before parsing — every accepted field is
	// schema-capped (~20 KB total), so anything over 32 KB is abuse. (Aggregate
	// request-rate flood control is enforced at the edge by Cloud Armor.)
	if (declaredBodyTooLarge(req, CLIENT_ERROR_MAX_BYTES)) {
		return new Response(null, { status: 413 });
	}

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return new Response(null, { status: 400 });
	}

	const parsed = clientErrorSchema.safeParse(body);
	if (!parsed.success) {
		return new Response(null, { status: 400 });
	}

	const { message, stack, source, url, componentStack } = parsed.data;

	/*
	 * Build a composite message that reads well in Cloud Logging's log viewer.
	 * The labels make it filterable; the stack_trace feeds Error Reporting.
	 * Component stacks (from React error boundaries) are appended to the
	 * regular stack since they're complementary — JS stack shows the throw
	 * site, component stack shows the React tree path.
	 */
	const fullStack =
		[stack, componentStack && `\nComponent Stack:\n${componentStack}`]
			.filter(Boolean)
			.join("") || undefined;

	/*
	 * Construct a real Error so `log.error` can extract the stack naturally.
	 * Overwriting `.stack` with the client's trace preserves the frame info
	 * GCP Error Reporting needs while keeping the logger API clean.
	 */
	const errorObj = new Error(message);
	if (fullStack) errorObj.stack = fullStack;

	/* `{ sentry: false }`: every payload reaching this endpoint already
	 * reached Sentry from the browser — the SDK's global handlers capture
	 * window.onerror/unhandledrejection first-hand, and `reportClientError`
	 * explicitly captures boundary/manual reports. Recapturing here would
	 * duplicate each browser error as a second server-side issue with a
	 * worse, string-rebuilt stack. */
	log.error(
		`[client] ${message}`,
		errorObj,
		{ source, url, origin: "client" },
		{ sentry: false },
	);

	return new Response(null, { status: 204 });
}
