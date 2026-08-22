/**
 * Client error logging endpoint: receives browser-side errors and logs
 * them as structured JSON for GCP Cloud Logging.
 *
 * No auth required: errors can happen before, during, or after
 * authentication (sign-in flow errors, token expiry, etc.). The endpoint
 * validates and sanitizes the payload to prevent abuse.
 *
 * Uses the structured logger (`lib/logger.ts`) so these errors appear in
 * Cloud Logging with proper severity, stack traces for Error Reporting
 * grouping, and filterable `source: client` labels alongside server errors.
 */
import { z } from "zod/v4";
import { CLIENT_ERROR_MAX_BYTES, declaredBodyTooLarge } from "@/lib/apiError";
import {
	CLIENT_ERROR_LIMITS,
	clientErrorUtf8Bytes,
	normalizeClientErrorPayload,
} from "@/lib/clientErrorContract";
import { log } from "@/lib/logger";

// ── Payload Schema ────────────────────────────────────────────────────

/** Max length for string fields to prevent oversized payloads. */
const diagnosticString = z.string().max(CLIENT_ERROR_LIMITS.diagnosticString);
const shortDiagnosticString = z
	.string()
	.max(CLIENT_ERROR_LIMITS.shortDiagnosticString);

const truncationSchema = z
	.object({
		messageBytes: z.number().int().nonnegative().optional(),
		stackBytes: z.number().int().nonnegative().optional(),
		componentStackBytes: z.number().int().nonnegative().optional(),
		urlBytes: z.number().int().nonnegative().optional(),
		diagnosticFields: z
			.array(shortDiagnosticString)
			.max(CLIENT_ERROR_LIMITS.truncatedFields)
			.optional(),
	})
	.strict();

const diagnosticsSchema = z
	.object({
		component: shortDiagnosticString.optional(),
		operation: shortDiagnosticString.optional(),
		failureKind: shortDiagnosticString.optional(),
		appId: shortDiagnosticString.optional(),
		clientBuildId: shortDiagnosticString.optional(),
		baseSeq: z.number().int().nonnegative().optional(),
		eventId: shortDiagnosticString.optional(),
		payloadBytes: z.number().int().nonnegative().optional(),
		httpStatus: z.number().int().nonnegative().optional(),
		mutationIndex: z.number().int().nonnegative().nullable().optional(),
		pointer: diagnosticString.optional(),
		reason: shortDiagnosticString.optional(),
		recoveryTrigger: shortDiagnosticString.optional(),
		issues: z
			.array(diagnosticString)
			.max(CLIENT_ERROR_LIMITS.issues)
			.optional(),
		truncation: truncationSchema.optional(),
	})
	.strict();

// ── Server-side flood control ─────────────────────────────────────────
//
// This endpoint is intentionally public, and the only client-side throttle
// (`lib/clientErrorReporter.ts`) is bypassed by a direct HTTP caller. Without
// a bound, an anonymous client can emit unbounded production `ERROR` records:
// Cloud Logging cost + alert fatigue (CWE-770).
//
// The rate limit lives at the EDGE in Cloud Armor, NOT in app code: a per-IP
// throttle rule (60 req / 60s → 429) on the `nova-armor` security policy
// attached to the Global External Application Load Balancer that fronts Cloud
// Run drops the flood before it reaches this service (so it costs no Cloud Run
// request at all). See `scripts/infra/setup-cloud-armor-lb.sh`. The route keeps
// only the per-request body-size cap below; aggregate request-rate control is
// the edge's job.

const clientErrorSchema = z
	.object({
		message: z.string(),
		stack: z.string().optional(),
		source: z.enum([
			"window.onerror",
			"unhandledrejection",
			"error-boundary",
			"manual",
		]),
		url: z.string(),
		componentStack: z.string().optional(),
		diagnostics: diagnosticsSchema.optional().default({}),
	})
	.strict();

// ── Route Handler ─────────────────────────────────────────────────────

export async function POST(req: Request) {
	// Reject a declared-oversized body before parsing. Producer + route
	// normalization keep emitted records under 28 KB; the 32 KB input ceiling
	// leaves JSON overhead without letting a stale client emit an unbounded log.
	// (Aggregate request-rate flood control is enforced at the edge by Cloud Armor.)
	if (declaredBodyTooLarge(req, CLIENT_ERROR_MAX_BYTES)) {
		return new Response(null, { status: 413 });
	}

	let bodyText: string;
	try {
		bodyText = await req.text();
	} catch {
		return new Response(null, { status: 400 });
	}
	if (clientErrorUtf8Bytes(bodyText) > CLIENT_ERROR_MAX_BYTES) {
		return new Response(null, { status: 413 });
	}

	let body: unknown;
	try {
		body = JSON.parse(bodyText);
	} catch {
		return new Response(null, { status: 400 });
	}

	const parsed = clientErrorSchema.safeParse(body);
	if (!parsed.success) {
		return new Response(null, { status: 400 });
	}

	/* Normalize again at the trust boundary. This keeps stale pre-normalizer
	 * clients useful during a rolling deploy (including the former 22 KB Zod
	 * pseudo-stack) without accepting an unbounded Cloud Logging record. Preserve
	 * the client-declared build id; absence means an old/unknown client, not this
	 * server's build. */
	const { message, stack, source, url, componentStack, diagnostics } =
		normalizeClientErrorPayload(parsed.data, {
			clientBuildId: parsed.data.diagnostics.clientBuildId ?? null,
		});

	/*
	 * Build a composite message that reads well in Cloud Logging's log viewer.
	 * The labels make it filterable; the stack_trace feeds Error Reporting.
	 * Component stacks (from React error boundaries) are appended to the
	 * regular stack since they're complementary: JS stack shows the throw
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
	 * reached Sentry from the browser: the SDK's global handlers capture
	 * window.onerror/unhandledrejection first-hand, and `reportClientError`
	 * explicitly captures boundary/manual reports. Recapturing here would
	 * duplicate each browser error as a second server-side issue with a
	 * worse, string-rebuilt stack. */
	log.error(
		`[client] ${message}`,
		errorObj,
		{ source, url, origin: "client", ...diagnostics },
		{ sentry: false },
	);

	return new Response(null, { status: 204 });
}
