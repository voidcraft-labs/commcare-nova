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
 * Per-route request-body byte budgets. Every JSON route should reject a
 * declared-oversized body BEFORE materializing it, so a single request can't
 * make the server buffer and parse an arbitrarily large payload (CWE-400)
 * ahead of any auth or schema check. The values are deliberately generous —
 * they exist to reject the pathological, never a real request — and all sit
 * well under Cloud Run's ~32 MB inbound limit so the platform stays the
 * outer backstop.
 *
 * - `BLUEPRINT_REQUEST_MAX_BYTES` — routes that carry one `BlueprintDoc`
 *   (compile/export, CommCare HQ upload, app autosave). A blueprint is
 *   persisted as ONE Firestore document field, so it can never legitimately
 *   exceed Firestore's ~1 MiB document limit; 2 MB leaves ample room for the
 *   JSON envelope and a basis token while still bounding parse cost 16× below
 *   the platform ceiling.
 * - `CHAT_REQUEST_MAX_BYTES` — `/api/chat` also ships the blueprint PLUS the
 *   bounded message history (`MAX_CHAT_MESSAGES` turns, each typed message
 *   `MAX_CHAT_MESSAGE_CHARS`), so it gets a larger budget than the pure
 *   blueprint routes. This is the only UNauthenticated parse, so the cap is
 *   the first line before `resolveAnthropicKey`.
 * - `CLIENT_ERROR_MAX_BYTES` — the public `/api/log/error` relay, whose
 *   schema caps every field; the sum of those caps is ~20 KB, so 32 KB
 *   accepts every valid report and rejects the rest.
 * - `OAUTH_REVOKE_MAX_BYTES` — the auth wrapper's pre-handler revoke-token
 *   read, whose body is a single token.
 */
export const BLUEPRINT_REQUEST_MAX_BYTES = 2 * 1024 * 1024;
export const CHAT_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
export const CLIENT_ERROR_MAX_BYTES = 32 * 1024;
export const OAUTH_REVOKE_MAX_BYTES = 16 * 1024;

/**
 * The cheap declared-size gate shared by every body-capped route: a request
 * that DECLARES (via `Content-Length`) a body over `maxBytes` is rejected
 * without touching the stream. A chunked request that omits `Content-Length`
 * isn't caught here — the platform's request-body limit (Cloud Run) is the
 * backstop for that case; this rejects the common declared-large case, it
 * doesn't re-implement a streaming byte counter. Pure predicate so routes
 * that don't use `readJsonBody` (bare-`Response` handlers like the chat and
 * client-error routes) can apply the same gate in their own error shape.
 */
export function declaredBodyTooLarge(req: Request, maxBytes: number): boolean {
	// A duplicate Content-Length header comes back comma-joined ("100, 100"), so
	// `Number(...)` of the raw value would be NaN and slip an oversized body past
	// the gate. Take the first declared value (a request-smuggling-shaped input
	// gets caught here rather than waved through).
	const declared = Number(
		req.headers.get("content-length")?.split(",")[0]?.trim(),
	);
	return Number.isFinite(declared) && declared > maxBytes;
}

/**
 * Read a JSON request body, rejecting an oversized one with `ApiError(413)` for
 * routes that hand their `catch` to {@link handleApiError}; a non-JSON body
 * resolves to `null` (let the caller's Zod schema produce the field message).
 *
 * The cap is enforced TWICE: the cheap declared-size fast path
 * ({@link declaredBodyTooLarge}) rejects a `Content-Length`-large body without
 * reading the stream, and the ACTUAL byte length is re-checked after buffering.
 * The second check is load-bearing: a chunked request omits `Content-Length`
 * entirely, so the declared-size gate alone is advisory — it would wave a
 * headerless stream straight into the expensive `JSON.parse` + Zod. Buffering
 * is bounded by Cloud Run's ~32 MB inbound limit, so this can't itself be made
 * to hold unbounded memory.
 */
export async function readJsonBody(
	req: Request,
	maxBytes: number,
): Promise<unknown> {
	const tooLargeMessage = `Request body is too large — this endpoint accepts at most ${maxBytes} bytes of JSON.`;
	if (declaredBodyTooLarge(req, maxBytes)) {
		throw new ApiError(tooLargeMessage, 413);
	}
	const buf = await req.arrayBuffer();
	if (buf.byteLength > maxBytes) {
		throw new ApiError(tooLargeMessage, 413);
	}
	try {
		return JSON.parse(new TextDecoder().decode(buf));
	} catch {
		return null;
	}
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
