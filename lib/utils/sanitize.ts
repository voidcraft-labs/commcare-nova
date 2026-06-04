/**
 * Input sanitization utilities for API boundaries.
 *
 * Used by compile routes and anywhere user-controlled strings flow
 * into HTTP headers or filesystem operations.
 */

/**
 * Sanitize a user-provided string for use in a Content-Disposition filename.
 *
 * Strips characters that could enable response header injection (`"`, `\r`, `\n`)
 * and any other non-printable or filesystem-unsafe characters. Returns 'app' as
 * a fallback if the sanitized result is empty.
 *
 * The allowed class uses a LITERAL space, not `\s`: `\s` matches every
 * whitespace character — including `\r`, `\n`, and `\t` — so allowing it would
 * preserve the exact CR/LF this function exists to strip. A name carrying a
 * newline would then reach the `Content-Disposition` header and make the
 * platform's `Headers` constructor throw `invalid header value`, turning an
 * export into an opaque 500. Allow the space alone so interior CR/LF/tabs are
 * removed; `.trim()` then drops the leading/trailing spaces that survive.
 */
export function sanitizeFilename(name: string): string {
	return name.replace(/[^\w .()-]/g, "").trim() || "app";
}
