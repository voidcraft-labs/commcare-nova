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

/**
 * Sanitize an owner-controlled string for use as a ZIP archive MEMBER name —
 * a safe relative leaf. Unlike {@link sanitizeFilename} (which must stay ASCII
 * because it lands in an HTTP `Content-Disposition` header value, a Latin-1
 * ByteString), an archive member name is UTF-8, so this PRESERVES letters and
 * digits in any script (`调查表`, `Café Survey`) and strips only what makes a
 * path unsafe: path separators (`/`, `\`), the Windows drive colon, the
 * filesystem-reserved set, CR/LF/tab, and any leading dot run
 * (so the result can't read as `..`/`.`-relative traversal). Falls back to
 * "app" when nothing survives.
 */
export function sanitizeArchiveMemberName(name: string): string {
	return (
		name
			.replace(/[\\/:*?"<>|\r\n\t]/g, "")
			.replace(/^\.+/, "")
			.trim() || "app"
	);
}
