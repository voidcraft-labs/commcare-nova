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
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[^\w\s.()-]/g, '').trim() || 'app'
}
