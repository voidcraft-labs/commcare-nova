/**
 * Client error logging endpoint — receives browser-side errors and logs
 * them as structured JSON for GCP Cloud Logging.
 *
 * No auth required — errors can happen before, during, or after
 * authentication (sign-in flow errors, token expiry, etc.). The endpoint
 * validates and sanitizes the payload to prevent abuse.
 *
 * Uses the structured logger (`lib/log.ts`) so these errors appear in
 * Cloud Logging with proper severity, stack traces for Error Reporting
 * grouping, and filterable `source: client` labels alongside server errors.
 */
import { z } from "zod/v4";
import { log } from "@/lib/log";

// ── Payload Schema ────────────────────────────────────────────────────

/** Max length for string fields to prevent oversized payloads. */
const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;
const MAX_URL = 2000;

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

	log.error(`[client] ${message}`, errorObj, { source, url, origin: "client" });

	return new Response(null, { status: 204 });
}
