/**
 * Client-side reader for the API error body shape every route emits via
 * `handleApiError` — `{ error: string, details?: string[] }`. The
 * boundary-gate rejections (compile / export / HQ upload) put each
 * validator finding's person-to-person message on a `details` line; this
 * helper is how the affordance that triggered the request surfaces those
 * lines instead of a generic "failed" notice.
 *
 * Pure and total over unknown input: a non-JSON body, a missing `error`
 * key, or a malformed `details` array all degrade to the caller's
 * fallback message with zero detail lines.
 */

export interface ApiFailure {
	/** The route's top-line message, or the caller's fallback. */
	message: string;
	/** Per-issue detail lines (already human-readable). Empty when the
	 *  response carried none. */
	details: string[];
}

/** Parse an API error response body (already JSON-decoded; pass `null`
 *  when decoding failed) into the message + detail lines to display. */
export function describeApiFailure(
	body: unknown,
	fallbackMessage: string,
): ApiFailure {
	if (body === null || typeof body !== "object") {
		return { message: fallbackMessage, details: [] };
	}
	const record = body as Record<string, unknown>;
	const message =
		typeof record.error === "string" && record.error.length > 0
			? record.error
			: fallbackMessage;
	const details = Array.isArray(record.details)
		? record.details.filter((d): d is string => typeof d === "string")
		: [];
	return { message, details };
}

/** Project an `ApiFailure` onto the toast's body shape: detail lines ride
 *  the structured `lines` option (each finding gets its own row chrome);
 *  a detail-less failure rides the plain `message`. */
export function apiFailureToastBody(failure: ApiFailure): {
	message: string | undefined;
	lines: string[] | undefined;
} {
	return failure.details.length > 0
		? { message: undefined, lines: failure.details }
		: { message: failure.message, lines: undefined };
}
