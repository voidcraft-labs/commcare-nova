import { NextResponse } from "next/server";
import { log } from "@/lib/logger";

/**
 * Extract a human-readable error message from a raw error string.
 * API routes return `{ error: string }` JSON — the AI SDK may pass the
 * raw response body as the error message. This extracts the `error` field
 * if the string is parseable JSON, otherwise returns the raw string.
 */
export function parseApiErrorMessage(raw: string): string {
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed?.error === "string") return parsed.error;
	} catch {
		/* not JSON — use raw message */
	}
	return raw;
}

/**
 * Structured error class for API route handlers.
 * Carries an HTTP status code and optional detail strings
 * so that catch blocks can throw meaningful, typed errors.
 */
export class ApiError extends Error {
	/** HTTP status code to return to the client (e.g. 400, 401, 502). */
	readonly status: number;
	/** Optional detail lines surfaced in the JSON response body. */
	readonly details: string[];

	constructor(message: string, status: number, details: string[] = []) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.details = details;
	}
}

/**
 * Read a small JSON request body, rejecting a declared-oversized one
 * BEFORE materializing it. Routes whose body is a fixed-shape metadata
 * object (not a blueprint or chat transcript) pass a tight `maxBytes` so a
 * single authenticated request can't make the server buffer and parse an
 * arbitrarily large payload (CWE-400) ahead of the schema's own checks.
 *
 * `Content-Length` is the cheap gate: a request that DECLARES a body over
 * the cap is rejected without touching the stream. A chunked request that
 * omits `Content-Length` falls through to `req.json()` — the platform's
 * request-body limit (Cloud Run caps inbound bodies) is the backstop
 * there; this helper rejects the common declared-large case, it doesn't
 * re-implement a streaming byte counter.
 *
 * Mirrors the route's existing lenient parse: a non-JSON body resolves to
 * `null` (let the caller's Zod schema produce the field-level message),
 * while an over-cap body throws `ApiError(413)`.
 */
export async function readJsonBody(
	req: Request,
	maxBytes: number,
): Promise<unknown> {
	const declared = Number(req.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new ApiError(
			`Request body is too large — this endpoint accepts at most ${maxBytes} bytes of JSON.`,
			413,
		);
	}
	return req.json().catch(() => null);
}

/**
 * Converts an error into a consistent JSON error response.
 *
 * - `ApiError`  -> uses its status and details directly
 * - `Error`     -> 500 with the error message
 * - anything else -> 500 with a generic message
 *
 * Response shape: `{ error: string, details?: string[] }`
 */
export function handleApiError(err: ApiError | Error): NextResponse {
	if (err instanceof ApiError) {
		const body: { error: string; details?: string[] } = { error: err.message };
		if (err.details.length > 0) {
			body.details = err.details;
		}
		return NextResponse.json(body, { status: err.status });
	}

	// Standard Error — return a generic message to avoid leaking internal
	// details (file paths, stack fragments, library internals) to the client.
	log.error("[apiError] unhandled", err);
	return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
